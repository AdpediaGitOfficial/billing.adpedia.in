import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { postReceipt } from '@/server/services/accounting/rules/invoice'
import { allocateNumber } from '@/server/services/invoicing/numbering'
import { noteTotals } from '@/server/services/invoicing/notes'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import { fyQuarter } from '@/lib/fy'
import { requireDefaultBank } from '@/server/services/company/bank-account'
import { isForeign, toInr } from '@/lib/fx'

export interface ReceiptAllocationInput {
  invoiceId: string
  amount: string
  tdsAmount?: string
}

export interface CreateReceiptInput {
  customerId: string
  date: string
  mode: 'NEFT' | 'RTGS' | 'IMPS' | 'UPI' | 'CHEQUE' | 'CASH' | 'CARD' | 'SWIFT' | 'OTHER'
  reference?: string
  bankAccountId?: string
  bankCharge?: string
  /** rupees; typed only for a rupee receipt — a foreign one derives it (docs/91) */
  fxGainLoss?: string
  /**
   * docs/91 — for a foreign-currency receipt, the RUPEES the bank actually credited (read it
   * off the statement or the FIRC). The allocations are in the invoices' own currency.
   */
  inrAmount?: string
  allocations: ReceiptAllocationInput[]
}

/**
 * docs/12 §2.4. TDS is recognised HERE, not when the invoice is raised, because
 * until the money arrives we do not know whether the customer deducted at all.
 */
export async function createReceipt(ctx: RequestContext, input: CreateReceiptInput) {
  assertCan(ctx.role, 'receipts', 'write')
  if (input.allocations.length === 0) throw new AppError('Allocate the receipt to at least one invoice')

  const date = new Date(input.date)
  const fy = await assertPostable(ctx.companyId, date)

  const result = await prisma.$transaction(async (tx) => {
    const bank = input.bankAccountId
      ? await tx.companyBankAccount.findFirstOrThrow({ where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true } })
      : await requireDefaultBank(tx, ctx.companyId)
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)

    let cash = ZERO, tdsTotal = ZERO
    let tdsSection: string | null = null
    const touched: { invoiceId: string; amount: Decimal; tds: Decimal }[] = []
    // docs/91 — the currency every invoice here is in, and the rupees the receivable being
    // cleared was carried at (invoice rate, not today's)
    let currency: string | null = null
    let arCleared = ZERO

    // 🔴 docs/86 — what an invoice still asks for is net of its credit notes. This guard read
    // `grandTotal` and so accepted ₹1,18,000 against an invoice the company had already
    // credited down to ₹94,400: money banked that had been given back, and an invoice marked
    // PAID with a receipt larger than the debt.
    const notes = await noteTotals(ctx.companyId, input.allocations.map((a) => a.invoiceId), tx)

    for (const a of input.allocations) {
      const inv = await tx.invoice.findFirst({ where: { id: a.invoiceId, companyId: ctx.companyId }, include: { customer: true } })
      if (!inv) throw new NotFound(`Invoice ${a.invoiceId} not found`)
      if (inv.status === 'CANCELLED') throw new AppError(`Invoice ${inv.number} is cancelled`)
      if (inv.status === 'DRAFT') throw new AppError(`Invoice ${inv.number} has not been sent yet`)

      /**
       * 🔴 The receipt's client must own the invoice it settles — docs/86.
       *
       * Nothing checked. The form only ever sends the chosen client's own invoices and the
       * bank matcher builds both sides off one invoice, so the happy paths agree; the service
       * accepted any pairing. A receipt recorded against the wrong client credits THEIR
       * receivable while the invoice of another is marked paid, and both running accounts are
       * then wrong — in opposite directions, so the trial balance still balances and nothing
       * says a word.
       */
      if (inv.customerId !== input.customerId) {
        throw new AppError(
          `${inv.number} was raised to ${inv.customer.name}, who is not the client this receipt is from. ` +
          'A receipt settles one client\'s invoices — record a separate one for each.',
        )
      }

      const amount = round2(new Decimal(a.amount))
      const tds = round2(new Decimal(a.tdsAmount ?? '0'))

      if (currency !== null && currency !== inv.currency) {
        throw new AppError(
          `${inv.number} is in ${inv.currency} but the other invoices on this receipt are in ${currency}. ` +
          'A receipt is one payment in one currency — record a separate one for each.',
        )
      }
      currency = inv.currency
      if (isForeign(inv.currency)) {
        if (tds.gt(0)) throw new AppError(`${inv.number} is an export in ${inv.currency}; an overseas client does not deduct Indian TDS, so none can be recorded on it.`)
        // 🔴 cumulative, not per-receipt: rounding each part separately can leave a paisa in
        // 1100 when the last receipt closes the invoice. Differencing the running total means
        // the parts always add up to exactly the rupee value of the whole.
        const before = new Decimal(inv.amountReceived.toString())
        const rate = new Decimal(inv.fxRate.toString())
        arCleared = arCleared.plus(toInr(before.plus(amount), rate).minus(toInr(before, rate)))
      }

      const outstanding = invoiceOpen(inv, notes.get(inv.id) ?? NO_NOTES).outstanding
      if (amount.plus(tds).gt(outstanding.plus('0.5'))) {
        throw new AppError(`Allocating ₹${amount.plus(tds).toFixed(2)} to ${inv.number} exceeds its outstanding ₹${outstanding.toFixed(2)}`)
      }

      cash = cash.plus(amount)
      tdsTotal = tdsTotal.plus(tds)
      if (tds.gt(0)) tdsSection = tdsSection ?? inv.tdsSection ?? '194J'
      touched.push({ invoiceId: inv.id, amount, tds })
    }

    const { number } = await allocateNumber(tx, { companyId: ctx.companyId, financialYearId: fy.id, docType: 'RECEIPT', fyLabel: fy.label })
    const bankCharge = round2(new Decimal(input.bankCharge ?? '0'))
    let fxGainLoss = round2(new Decimal(input.fxGainLoss ?? '0'))
    const foreign = isForeign(currency)
    let inrAmount: Decimal | null = null
    if (foreign) {
      /**
       * 🔴 docs/91 — the forex difference is DERIVED, never typed. Rupees in the bank plus the
       * charges the bank took, less the rupees of receivable this payment clears at the
       * invoice's own rate. Positive is a gain (4920), negative a loss (5900) — and
       * `postReceipt` turns that back into the receivable it clears.
       */
      if (input.fxGainLoss && !round2(new Decimal(input.fxGainLoss)).isZero()) {
        throw new AppError('The forex gain or loss on a foreign receipt is worked out from the rupees received — do not enter it.')
      }
      inrAmount = input.inrAmount ? round2(new Decimal(input.inrAmount)) : null
      if (!inrAmount || inrAmount.lte(0)) {
        throw new AppError(`Enter the rupees the bank credited for this ${currency} receipt. The books are kept in rupees, and the difference from the invoice's rate is booked as forex gain or loss.`)
      }
      fxGainLoss = inrAmount.plus(bankCharge).minus(arCleared)
    } else if (input.inrAmount) {
      throw new AppError('The rupees credited are only for a foreign-currency receipt.')
    }

    const receipt = await tx.receipt.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, customerId: input.customerId,
        number, date, mode: input.mode, amount: cash.toFixed(2), tdsAmount: tdsTotal.toFixed(2),
        currency: currency ?? 'INR', inrAmount: inrAmount ? inrAmount.toFixed(2) : null,
        bankChargeAmount: bankCharge.toFixed(2), fxGainLoss: fxGainLoss.toFixed(2),
        reference: input.reference, bankAccountId: bank.id,
        allocations: { create: touched.map((t) => ({ invoiceId: t.invoiceId, amount: t.amount.toFixed(2), tdsAmount: t.tds.toFixed(2) })) },
      },
    })

    await postJournal(ctx, {
      date, narration: `Receipt ${number}`, sourceType: 'RECEIPT', sourceId: receipt.id,
      postings: postReceipt({
        number, customerId: input.customerId,
        amount: inrAmount ?? cash, tdsAmount: tdsTotal, tdsSection,
        bankCharge, fxGainLoss, bankAccountCode: bank.ledgerAccount.code,
      }),
    }, tx)

    // update each invoice's position and, where TDS was deducted, create the
    // TdsReceivable row that will later reconcile against Form 26AS
    for (const t of touched) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: t.invoiceId } })
      const received = new Decimal(inv.amountReceived.toString()).plus(t.amount)
      const credited = new Decimal(inv.tdsCredited.toString()).plus(t.tds)
      // 🔴 against the invoice NET of its notes — otherwise a credited invoice paid in full
      // stays PARTIALLY_PAID for ever and keeps chasing the amount that was credited away
      const { settled } = invoiceOpen(
        { ...inv, amountReceived: received, tdsCredited: credited },
        notes.get(t.invoiceId) ?? NO_NOTES,
      )

      await tx.invoice.update({
        where: { id: t.invoiceId },
        data: {
          amountReceived: received.toFixed(2),
          tdsCredited: credited.toFixed(2),
          status: settled ? 'PAID' : 'PARTIALLY_PAID',
        },
      })

      if (t.tds.gt(0)) {
        await tx.tdsReceivable.create({
          data: {
            companyId: ctx.companyId, financialYearId: fy.id, quarter: fyQuarter(date),
            invoiceId: inv.id, customerId: inv.customerId,
            sectionCode: inv.tdsSection ?? '194J',
            baseAmount: inv.taxableValue.toString(),
            tdsAmount: t.tds.toFixed(2),
            bookedOn: date,
          },
        })
      }
    }

    await audit(ctx, { entity: 'Receipt', entityId: receipt.id, action: 'CREATE', after: { number, amount: cash.toFixed(2), tds: tdsTotal.toFixed(2) } }, tx)
    return receipt
  })

  // 🔴 Outside the transaction, and deliberately not awaited into the result. A push
  // service being slow or down must never roll back a receipt that is already posted —
  // the money arrived whether or not anyone's phone buzzed.
  void notifyPaymentReceived(ctx, result.id).catch(() => {})

  return result
}

async function notifyPaymentReceived(ctx: RequestContext, receiptId: string) {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: {
      amount: true, customer: { select: { name: true } },
      allocations: { select: { invoiceId: true }, take: 1 },
    },
  })
  if (!receipt) return
  const { pushToCompany, messages } = await import('@/server/services/notify/push')
  await pushToCompany(
    ctx.companyId,
    messages.paymentReceived(receipt.customer.name, receipt.amount.toString(), receipt.allocations[0]?.invoiceId ?? ''),
    ['OWNER', 'ACCOUNTANT'],
  )
}
