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
  fxGainLoss?: string
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
      : await tx.companyBankAccount.findFirstOrThrow({ where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true } })
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)

    let cash = ZERO, tdsTotal = ZERO
    let tdsSection: string | null = null
    const touched: { invoiceId: string; amount: Decimal; tds: Decimal }[] = []

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
    const fxGainLoss = round2(new Decimal(input.fxGainLoss ?? '0'))

    const receipt = await tx.receipt.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, customerId: input.customerId,
        number, date, mode: input.mode, amount: cash.toFixed(2), tdsAmount: tdsTotal.toFixed(2),
        bankChargeAmount: bankCharge.toFixed(2), fxGainLoss: fxGainLoss.toFixed(2),
        reference: input.reference, bankAccountId: bank.id,
        allocations: { create: touched.map((t) => ({ invoiceId: t.invoiceId, amount: t.amount.toFixed(2), tdsAmount: t.tds.toFixed(2) })) },
      },
    })

    await postJournal(ctx, {
      date, narration: `Receipt ${number}`, sourceType: 'RECEIPT', sourceId: receipt.id,
      postings: postReceipt({
        number, customerId: input.customerId,
        amount: cash, tdsAmount: tdsTotal, tdsSection,
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
