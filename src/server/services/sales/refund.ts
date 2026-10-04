import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { allocateNumber } from '@/server/services/invoicing/numbering'
import { advanceTaxPosted } from './advance'

const ADVANCE_ACCOUNT = '2400'
const OUTPUT = { cgst: '2110', sgst: '2120', igst: '2130' } as const

/**
 * Returning an advance — docs/65.
 *
 * 🔴 A refund voucher is **not** a credit note, and reaching for one is the mistake this
 * exists to prevent. A credit note under s.34(1) credits an invoice; here there is no
 * invoice, because the supply never happened. s.31(3)(e) provides a document of its own, and
 * rule 51 fixes its contents down to the receipt-voucher number it refunds against.
 *
 * The tax matters. docs/54 established that GST falls due on an advance for services the
 * moment it arrives — s.13(2) with Notification 66/2017 — so by the time the money goes back,
 * the company has already declared and very likely paid tax on a supply that never occurred.
 * Without this document and the adjustment that follows it, that money is simply lost.
 */

export interface RefundPreview {
  receiptNumber: string
  customerName: string
  /** what is left on the advance after any adjustments and earlier refunds */
  available: Decimal
  amount: Decimal
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  taxBack: Decimal
  notes: string[]
  warnings: string[]
}

export interface RefundInput {
  receiptId: string
  date: string
  amount: string
  reason: string
  bankAccountId?: string
}

/** What is left of an advance: the gross, less what was adjusted and what was already refunded. */
export async function advanceAvailable(companyId: string, receiptId: string) {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, companyId, isAdvance: true },
    include: { allocations: true, refunds: { where: { cancelledAt: null } }, customer: true },
  })
  if (!receipt) throw new NotFound('Advance not found')

  const gross = new Decimal(receipt.amount.toString()).plus(receipt.tdsAmount.toString())
  const adjusted = receipt.allocations.reduce(
    (a, x) => a.plus(x.amount.toString()).plus(x.tdsAmount.toString()), ZERO as Decimal,
  )
  const refunded = receipt.refunds.reduce((a, r) => a.plus(r.amount.toString()), ZERO as Decimal)
  return { receipt, gross, adjusted, refunded, available: gross.minus(adjusted).minus(refunded) }
}

export async function previewRefund(ctx: RequestContext, input: RefundInput): Promise<RefundPreview> {
  assertCan(ctx.role, 'receipts', 'read')

  const { receipt, adjusted, refunded, available } = await advanceAvailable(ctx.companyId, input.receiptId)
  const amount = round2(new Decimal(input.amount || '0'))

  const notes: string[] = []
  const warnings: string[] = []

  /**
   * 🔴 The heads reversed are the heads that were POSTED, pro rata — the same rule as
   * docs/54 §3, and for the same reason. An advance whose place of supply was unknown was
   * charged IGST under rule 50; refunding it against CGST and SGST would take tax out of
   * accounts that were never credited and leave the IGST there for ever.
   */
  const posted = await advanceTaxPosted(ctx.companyId, receipt.id)
  const postedTax = posted.cgst.plus(posted.sgst).plus(posted.igst)
  const share = available.gt(0) && amount.gt(0) ? amount.div(available) : ZERO

  const cgst = round2(posted.cgst.mul(share))
  const sgst = round2(posted.sgst.mul(share))
  const igst = round2(posted.igst.mul(share))
  const taxBack = cgst.plus(sgst).plus(igst)
  const taxableValue = amount.minus(taxBack)

  if (adjusted.gt(0)) {
    notes.push(`${formatINR(adjusted)} of this advance has already been adjusted against an invoice; only the rest can be refunded.`)
  }
  if (refunded.gt(0)) {
    notes.push(`${formatINR(refunded)} has already been refunded on an earlier voucher.`)
  }
  if (postedTax.gt(0)) {
    notes.push(
      `The advance was tax-inclusive under rule 50, so the refund is too: of ${formatINR(amount)} going back, ` +
      `${formatINR(taxBack)} is the tax declared when it arrived.`,
    )
  } else {
    warnings.push(
      'No GST was charged on this advance, so none comes back. If it should have been, the receipt is wrong rather than this refund.',
    )
  }
  notes.push(
    'The tax is recovered by adjusting it in the return for the period of this voucher — it is not a credit note, and it does not touch any invoice.',
  )
  if (amount.gt(0) && amount.lt(available) && share.lt(1)) {
    notes.push('A part refund takes back a proportional slice of the tax, head by head.')
  }

  return {
    receiptNumber: receipt.number,
    customerName: receipt.customer.name,
    available, amount, taxableValue, cgst, sgst, igst, taxBack, notes, warnings,
  }
}

export async function createRefundVoucher(ctx: RequestContext, input: RefundInput) {
  assertCan(ctx.role, 'receipts', 'write')

  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('That is not a valid date')
  if (!input.reason?.trim()) {
    // rule 51(f) requires it, and so does anybody looking at this in two years
    throw new AppError('A refund voucher must say why the money is going back — rule 51 requires it on the document')
  }

  const fy = await assertPostable(ctx.companyId, date)
  const p = await previewRefund(ctx, input)
  const amount = round2(new Decimal(input.amount || '0'))

  if (amount.lte(0)) throw new AppError('A refund needs an amount')
  if (amount.gt(p.available.plus('0.5'))) {
    throw new AppError(
      `Only ${formatINR(p.available)} of advance ${p.receiptNumber} is left — ` +
      'the rest has been adjusted against an invoice or already refunded.',
    )
  }

  const { receipt } = await advanceAvailable(ctx.companyId, input.receiptId)
  if (receipt.cancelledAt) throw new AppError('That advance is cancelled')
  if (receipt.date > date) {
    throw new AppError(`The advance was received on ${receipt.date.toISOString().slice(0, 10)}; a refund cannot be dated before it`)
  }

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
      companyId: ctx.companyId, financialYearId: fy.id, docType: 'REFUND_VOUCHER', fyLabel: fy.label,
    })

    const voucher = await tx.refundVoucher.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id,
        receiptId: receipt.id, customerId: receipt.customerId,
        number, date, reason: input.reason.trim(),
        amount: amount.toFixed(2), taxableValue: p.taxableValue.toFixed(2),
        cgst: p.cgst.toFixed(2), sgst: p.sgst.toFixed(2), igst: p.igst.toFixed(2),
        bankAccountId: bank.id,
      },
    })

    /**
     * The exact mirror of the receipt: the liability and the tax come off, the bank pays out.
     *
     * 🔴 Filed under the VOUCHER, not the advance it refunds — docs/69. It posted as
     * `sourceType: 'RECEIPT'` against the receipt's own id until then, because `SourceType`
     * had no member for it, and that made `cancelReceipt` reverse the refund along with the
     * advance while leaving the voucher live and still in GSTR-1 table 11B. A document's
     * postings belong to the document, or nothing can find them to undo.
     */
    await postJournal(ctx, {
      date,
      narration: `Refund voucher ${number} — advance ${receipt.number} returned to ${p.customerName}`,
      sourceType: 'REFUND_VOUCHER', sourceId: voucher.id,
      postings: [
        { accountCode: ADVANCE_ACCOUNT, debit: p.taxableValue, customerId: receipt.customerId },
        ...(p.cgst.gt(0) ? [{ accountCode: OUTPUT.cgst, debit: p.cgst, customerId: receipt.customerId }] : []),
        ...(p.sgst.gt(0) ? [{ accountCode: OUTPUT.sgst, debit: p.sgst, customerId: receipt.customerId }] : []),
        ...(p.igst.gt(0) ? [{ accountCode: OUTPUT.igst, debit: p.igst, customerId: receipt.customerId }] : []),
        { accountCode: bank.ledgerAccount!.code, credit: amount },
      ],
    }, tx)

    await audit(ctx, {
      entity: 'RefundVoucher', entityId: voucher.id, action: 'CREATE',
      after: { number, against: receipt.number, amount: amount.toFixed(2), taxBack: p.taxBack.toFixed(2) },
    }, tx)

    return voucher
  })
}

export async function listRefundVouchers(ctx: RequestContext) {
  assertCan(ctx.role, 'receipts', 'read')
  return prisma.refundVoucher.findMany({
    where: { companyId: ctx.companyId },
    include: { customer: { select: { name: true } }, receipt: { select: { number: true } } },
    orderBy: { date: 'desc' },
  })
}

/** Refunds in a period, for GSTR-1 table 11B — docs/65 §4. */
export async function refundsInPeriod(companyId: string, from: Date, to: Date) {
  return prisma.refundVoucher.findMany({
    where: { companyId, cancelledAt: null, date: { gte: from, lte: to } },
    include: { customer: { select: { name: true, stateCode: true } }, receipt: { select: { number: true } } },
    orderBy: { date: 'asc' },
  })
}
