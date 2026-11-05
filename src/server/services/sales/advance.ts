import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, halveTax } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { allocateNumber } from '@/server/services/invoicing/numbering'
import { notesFor } from '@/server/services/invoicing/notes'
import { invoiceOpen } from '@/lib/invoice-open'
import { fyQuarter } from '@/lib/fy'
import type { TaxMode } from '@prisma/client'

/**
 * Advances — money in before an invoice exists. docs/54.
 *
 * 🔴 **GST is payable on an advance for services.** This is the one everybody gets wrong,
 * because the rule changed for goods and not for services.
 *
 * s.13(2) fixes the time of supply for services as the earlier of the invoice date or the
 * date of receipt of payment. Notification 66/2017 relieved suppliers of **goods** from
 * paying tax on advances — and left services exactly where they were. Adpedia supplies
 * services, so an advance received today is a liability declared in today's return, months
 * before the invoice.
 *
 * What the supplier issues is a **receipt voucher** under s.31(3)(d), not a tax invoice.
 * The invoice follows when the supply is made, and the advance is adjusted against it.
 */

/** Advances sit in 2400 until an invoice absorbs them — a liability, not revenue. */
const ADVANCE_ACCOUNT = '2400'

export interface AdvanceInput {
  customerId: string
  date: string
  mode: 'NEFT' | 'RTGS' | 'IMPS' | 'UPI' | 'CHEQUE' | 'CASH' | 'CARD' | 'SWIFT' | 'OTHER'
  /** cash actually received */
  amount: string
  /** TDS the client withheld from the advance, if any */
  tdsAmount?: string
  /** the rate the supply will carry. Rule 50 says 18% where it is not determinable. */
  gstRatePct?: string
  reference?: string
  bankAccountId?: string
  description?: string
}

export interface AdvancePreview {
  customerName: string
  /** cash plus any TDS withheld — what the customer has actually paid against the supply */
  gross: Decimal
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  taxMode: TaxMode
  ratePct: Decimal
  notes: string[]
  warnings: string[]
}

/**
 * 🔴 Rule 50, both halves.
 *
 * Where the **rate** cannot be determined at the time of the advance, tax is paid at 18%.
 * Where the **nature of supply** cannot be determined, it is treated as inter-state. The
 * second is the counter-intuitive one: an unknown place of supply is IGST, not CGST+SGST,
 * because IGST can be reapportioned between the states afterwards and CGST+SGST cannot.
 */
function modeForAdvance(supplierState: string | null, customerState: string | null, country: string): TaxMode {
  if (country !== 'IN') return 'EXPORT'
  if (!customerState || !supplierState) return 'INTER'
  return customerState === supplierState ? 'INTRA' : 'INTER'
}

export async function previewAdvance(ctx: RequestContext, input: AdvanceInput): Promise<AdvancePreview> {
  assertCan(ctx.role, 'receipts', 'read')

  const [customer, company] = await Promise.all([
    prisma.customer.findFirst({ where: { id: input.customerId, companyId: ctx.companyId } }),
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } }),
  ])
  if (!customer) throw new NotFound('Customer not found')

  const cash = round2(new Decimal(input.amount || '0'))
  const tds = round2(new Decimal(input.tdsAmount ?? '0'))
  const gross = cash.plus(tds)

  const taxMode = modeForAdvance(company.stateCode, customer.stateCode, customer.country)
  const ratePct = taxMode === 'EXPORT'
    ? ZERO
    : round2(new Decimal(input.gstRatePct && input.gstRatePct !== '' ? input.gstRatePct : '18'))

  // 🔴 The advance arrives GST-INCLUSIVE. The customer pays a sum of money, not a taxable
  // value plus tax, so the tax inside it is backed out rather than added on top — rule 50's
  // "the amount of advance received shall be deemed to include the tax".
  const taxableValue = ratePct.gt(0) ? round2(gross.mul(100).div(ratePct.plus(100))) : gross
  const tax = gross.minus(taxableValue)

  let cgst = ZERO, sgst = ZERO, igst = ZERO
  if (taxMode === 'INTRA') ({ cgst, sgst } = halveTax(tax))
  else if (taxMode === 'INTER') igst = tax

  const notes: string[] = []
  if (taxMode === 'EXPORT') {
    notes.push(
      'An advance against an export of services carries no GST, the supply being zero-rated — but it is ' +
      'still a receipt voucher under s.31(3)(d), and the FIRC follows the money, not the invoice.',
    )
  } else {
    notes.push(
      `GST of ${tax.toFixed(2)} falls due in the return for the period this advance is received — s.13(2). ` +
      'Advances on GOODS were relieved of this by Notification 66/2017; services were not.',
    )
    notes.push(
      'It is reported in table 11A of GSTR-1 for this period, and in 11B of the period where the invoice ' +
      'finally absorbs it.',
    )
  }
  if (!input.gstRatePct && taxMode !== 'EXPORT') {
    notes.push('Rate taken as 18% — rule 50, where the rate is not determinable when the advance is received.')
  }
  if (!customer.stateCode && customer.country === 'IN') {
    notes.push(
      'The customer has no state on file, so the supply is treated as inter-state and charged IGST — rule 50. ' +
      'IGST can be reapportioned between the states later; CGST and SGST cannot.',
    )
  }

  const warnings: string[] = []
  if (cash.lte(0)) warnings.push('An advance needs an amount')
  if (tds.gt(0)) {
    warnings.push(
      `The client withheld ${tds.toFixed(2)} of TDS on the advance. That is correct — a deduction follows the ` +
      'payment, not the invoice — and it will appear in the 26AS for this quarter.',
    )
  }

  return {
    customerName: customer.name,
    gross, taxableValue, cgst, sgst, igst, taxMode, ratePct,
    notes, warnings,
  }
}

/**
 * Record the advance and the GST that falls due on it.
 *
 * The receipt voucher is numbered from the receipt series: in this system a receipt IS the
 * record of money arriving, and an advance is that record without an invoice behind it yet.
 */
export async function createAdvanceReceipt(ctx: RequestContext, input: AdvanceInput) {
  assertCan(ctx.role, 'receipts', 'write')

  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('That is not a valid date')
  const fy = await assertPostable(ctx.companyId, date)

  const p = await previewAdvance(ctx, input)
  const cash = round2(new Decimal(input.amount || '0'))
  const tds = round2(new Decimal(input.tdsAmount ?? '0'))
  if (cash.lte(0)) throw new AppError('An advance needs an amount')

  return prisma.$transaction(async (tx) => {
    const bank = input.bankAccountId
      ? await tx.companyBankAccount.findFirstOrThrow({
          where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true },
        })
      : await tx.companyBankAccount.findFirstOrThrow({
          where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true },
        })
    if (!bank.ledgerAccount) throw new AppError(`${bank.label} is not mapped to a ledger account`)

    const { number } = await allocateNumber(tx, {
      companyId: ctx.companyId, financialYearId: fy.id, docType: 'RECEIPT', fyLabel: fy.label,
    })

    const receipt = await tx.receipt.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, customerId: input.customerId,
        number, date, mode: input.mode,
        amount: cash.toFixed(2), tdsAmount: tds.toFixed(2),
        reference: input.reference, bankAccountId: bank.id,
        isAdvance: true,
      },
    })

    await postJournal(ctx, {
      date,
      narration: `Advance from ${p.customerName}${input.description ? ` — ${input.description}` : ''} (voucher ${number})`,
      sourceType: 'RECEIPT', sourceId: receipt.id,
      postings: [
        { accountCode: bank.ledgerAccount!.code, debit: cash },
        ...(tds.gt(0) ? [{ accountCode: '1310', debit: tds, customerId: input.customerId }] : []),
        // 🔴 a LIABILITY, not revenue — nothing has been supplied yet
        { accountCode: ADVANCE_ACCOUNT, credit: p.taxableValue, customerId: input.customerId },
        ...(p.cgst.gt(0) ? [{ accountCode: '2110', credit: p.cgst, customerId: input.customerId }] : []),
        ...(p.sgst.gt(0) ? [{ accountCode: '2120', credit: p.sgst, customerId: input.customerId }] : []),
        ...(p.igst.gt(0) ? [{ accountCode: '2130', credit: p.igst, customerId: input.customerId }] : []),
      ],
    }, tx)

    // the TDS the client withheld is ours to reconcile against 26AS, exactly as on a receipt
    if (tds.gt(0)) {
      // 🔴 No invoice to hang it on — that is the whole point of an advance. The credit is
      // still ours and still appears in this quarter's 26AS, so it is booked against the
      // customer and linked to the invoice later if anyone needs the join.
      await tx.tdsReceivable.create({
        data: {
          companyId: ctx.companyId, financialYearId: fy.id, quarter: fyQuarter(date),
          customerId: input.customerId, sectionCode: '194J',
          bookedOn: date, baseAmount: p.taxableValue.toFixed(2), tdsAmount: tds.toFixed(2),
        },
      })
    }

    await audit(ctx, {
      entity: 'Receipt', entityId: receipt.id, action: 'CREATE',
      after: {
        advance: true, number, gross: p.gross.toFixed(2),
        taxableValue: p.taxableValue.toFixed(2), taxMode: p.taxMode,
      },
    }, tx)

    return receipt
  })
}

export interface AdjustAdvanceInput {
  receiptId: string
  invoiceId: string
  /** gross amount of the advance being absorbed, GST included */
  amount: string
  date: string
}

/**
 * Absorb an advance into the invoice that finally covers it.
 *
 * 🔴 The tax paid on the advance is REVERSED here, because the invoice declares its own.
 * Leaving it would charge the same supply twice — once on receipt and once on invoicing —
 * which is precisely what GSTR-1's table 11B exists to prevent on the return side. The books
 * have to do the same thing or they stop agreeing with it.
 */
export async function adjustAdvance(ctx: RequestContext, input: AdjustAdvanceInput) {
  assertCan(ctx.role, 'receipts', 'write')

  const date = new Date(input.date)
  await assertPostable(ctx.companyId, date)

  const receipt = await prisma.receipt.findFirst({
    where: { id: input.receiptId, companyId: ctx.companyId, isAdvance: true },
    include: { customer: true, allocations: true },
  })
  if (!receipt) throw new NotFound('Advance not found')
  if (receipt.cancelledAt) throw new AppError('That advance is cancelled')

  const invoice = await prisma.invoice.findFirst({ where: { id: input.invoiceId, companyId: ctx.companyId } })
  if (!invoice) throw new NotFound('Invoice not found')
  if (invoice.status === 'DRAFT') throw new AppError(`${invoice.number} has not been sent yet`)
  if (invoice.status === 'CANCELLED') throw new AppError(`${invoice.number} is cancelled`)
  if (invoice.customerId !== receipt.customerId) {
    throw new AppError('That advance belongs to a different customer')
  }

  const gross = new Decimal(receipt.amount.toString()).plus(receipt.tdsAmount.toString())
  const alreadyAdjusted = receipt.allocations.reduce(
    (a, x) => a.plus(x.amount.toString()).plus(x.tdsAmount.toString()), ZERO,
  )
  const available = gross.minus(alreadyAdjusted)
  const amount = round2(new Decimal(input.amount))

  if (amount.lte(0)) throw new AppError('Nothing to adjust')
  if (amount.gt(available.plus('0.5'))) {
    throw new AppError(`Only ${available.toFixed(2)} of this advance is left to adjust`)
  }

  // 🔴 docs/86 — net of the credit notes against it, or an advance can be absorbed into a
  // debt the company has already given back, pushing 1100 negative for that client
  const open = invoiceOpen(invoice, await notesFor(ctx.companyId, invoice.id))
  const outstanding = open.outstanding
  if (amount.gt(outstanding.plus('0.5'))) {
    throw new AppError(
      `Adjusting ${amount.toFixed(2)} against ${invoice.number} exceeds its outstanding ${outstanding.toFixed(2)}`,
    )
  }

  // 🔴 What is reversed is what was POSTED, head by head, read back from the ledger.
  //
  // Not the invoice's heads. Under rule 50 an advance whose place of supply was unknown was
  // charged IGST; the invoice that finally covers it may be intra-state and carry CGST+SGST.
  // Debiting the invoice's heads would reverse tax out of accounts that were never credited
  // and leave the IGST sitting there for ever. The two sides are genuinely different, and the
  // return reports them that way too — 11B against the advance's own rate.
  const posted = await advanceTaxPosted(ctx.companyId, receipt.id)
  const share = available.gt(0) ? amount.div(available) : ZERO
  const cgst = round2(posted.cgst.mul(share))
  const sgst = round2(posted.sgst.mul(share))
  const igst = round2(posted.igst.mul(share))
  const taxBack = cgst.plus(sgst).plus(igst)
  const taxableBack = amount.minus(taxBack)

  return prisma.$transaction(async (tx) => {
    await postJournal(ctx, {
      date,
      narration: `Advance ${receipt.number} adjusted against ${invoice.number}`,
      sourceType: 'RECEIPT', sourceId: receipt.id,
      postings: [
        { accountCode: ADVANCE_ACCOUNT, debit: taxableBack, customerId: receipt.customerId },
        ...(cgst.gt(0) ? [{ accountCode: '2110', debit: cgst, customerId: receipt.customerId }] : []),
        ...(sgst.gt(0) ? [{ accountCode: '2120', debit: sgst, customerId: receipt.customerId }] : []),
        ...(igst.gt(0) ? [{ accountCode: '2130', debit: igst, customerId: receipt.customerId }] : []),
        { accountCode: '1100', credit: amount, customerId: receipt.customerId, projectId: invoice.projectId ?? undefined },
      ],
    }, tx)

    await tx.receiptAllocation.upsert({
      where: { receiptId_invoiceId: { receiptId: receipt.id, invoiceId: invoice.id } },
      update: { amount: amount.toFixed(2) },
      create: { receiptId: receipt.id, invoiceId: invoice.id, amount: amount.toFixed(2) },
    })

    const received = new Decimal(invoice.amountReceived.toString()).plus(amount)
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountReceived: received.toFixed(2),
        status: received.plus(invoice.tdsCredited.toString()).gte(open.gross.minus('0.5'))
          ? 'PAID'
          : 'PARTIALLY_PAID',
      },
    })

    await audit(ctx, {
      entity: 'Receipt', entityId: receipt.id, action: 'UPDATE',
      after: { adjustedAgainst: invoice.number, amount: amount.toFixed(2), taxReversed: taxBack.toFixed(2) },
    }, tx)

    return { ok: true, adjusted: amount, taxReversed: taxBack }
  })
}

/**
 * The tax still sitting on an advance, head by head.
 *
 * 🔴 Read back from the journal rather than stored, for the same reason a credit note derives
 * its rate from the invoice it credits: the rate table may have moved since, and an
 * adjustment has to reverse exactly what was posted — not what the rate would be today.
 * Earlier adjustments appear as debits, so what this returns is what is left.
 */
export async function advanceTaxPosted(companyId: string, receiptId: string) {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { companyId, code: { in: ['2110', '2120', '2130'] } },
      journalEntry: { companyId, sourceType: 'RECEIPT', sourceId: receiptId },
    },
    include: { account: { select: { code: true } } },
  })

  const net = (code: string) => lines
    .filter((l) => l.account.code === code)
    .reduce((a, l) => a.plus(l.credit.toString()).minus(l.debit.toString()), ZERO)

  return { cgst: net('2110'), sgst: net('2120'), igst: net('2130') }
}

/** Advances with something left to absorb — the invoice screen asks. */
export async function openAdvances(ctx: RequestContext, customerId?: string) {
  assertCan(ctx.role, 'receipts', 'read')
  const rows = await prisma.receipt.findMany({
    where: { companyId: ctx.companyId, isAdvance: true, cancelledAt: null, ...(customerId ? { customerId } : {}) },
    include: {
      customer: { select: { name: true } },
      allocations: true,
      // 🔴 docs/65 — refunds count as spent. Without this a fully refunded advance stays
      // "open": the screen offers to adjust money that has already gone back to the client,
      // and the service would let it, taking output tax out of accounts twice.
      refunds: { where: { cancelledAt: null } },
    },
    orderBy: { date: 'desc' },
  })
  return rows
    .map((r) => {
      const gross = new Decimal(r.amount.toString()).plus(r.tdsAmount.toString())
      const adjusted = r.allocations.reduce(
        (a, x) => a.plus(x.amount.toString()).plus(x.tdsAmount.toString()), ZERO,
      )
      const refunded = r.refunds.reduce((a, x) => a.plus(x.amount.toString()), ZERO)
      return {
        id: r.id, number: r.number, date: r.date,
        // 🔴 docs/78 — the caller needs WHOSE advance it is to offer invoices against it. It
        // was taking that from the receipts array on screen, which worked only while that
        // array was every receipt.
        customerId: r.customerId, customerName: r.customer.name,
        gross, adjusted, refunded, open: gross.minus(adjusted).minus(refunded),
      }
    })
    .filter((r) => r.open.gt('0.5'))
}
