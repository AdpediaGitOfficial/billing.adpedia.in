import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { reverseJournal } from './journal'
import { assertPostable } from './period'

/**
 * Undoing what was posted in error.
 *
 * Ten document types post journal entries; until now only invoices and vendor bills could be
 * cancelled. Everything else — a receipt against the wrong invoice, a payment entered twice,
 * an expense that was never ours, a bank line matched to the wrong document — was permanent.
 *
 * Every correction here follows the same three rules, which are the system's rules:
 *
 *   1. 🔴 **Reverse, never delete.** A new journal entry undoes the old one and both stay.
 *      The database refuses a hard delete on financial tables anyway, and rightly so.
 *   2. 🔴 **The period must be open.** A reversal is a posting like any other; letting it
 *      into a locked month would silently change a filed return.
 *   3. 🔴 **A reason, recorded.** Read later by whoever asks why the figures moved.
 */

function requireReason(reason: string) {
  if (reason.trim().length < 5) {
    throw new AppError('A correction needs a reason — it is the only record of why the figures moved')
  }
}

/* ── receipts ────────────────────────────────────────────────────────────────── */

/**
 * Cancel a receipt and put every invoice it touched back where it was.
 *
 * 🔴 Refused once the TDS has been matched to Form 26AS or claimed.
 *
 * At that point the credit is no longer just our record — it has been reconciled against
 * what the government says was deducted, and may already have been set off in a return.
 * Quietly unwinding it here would leave the books disagreeing with a filed position, and the
 * disagreement would surface at assessment rather than today. The fix for a receipt that
 * wrong is a conversation with the CA, not a button.
 */
export async function cancelReceipt(ctx: RequestContext, receiptId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'receipts', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  return prisma.$transaction(async (tx) => {
    const receipt = await tx.receipt.findFirst({
      where: { id: receiptId, companyId: ctx.companyId },
      include: { allocations: true },
    })
    if (!receipt) throw new NotFound('Receipt not found')
    if (receipt.cancelledAt) throw new AppError(`Receipt ${receipt.number} is already cancelled`)

    const claimed = await tx.tdsReceivable.findFirst({
      where: {
        companyId: ctx.companyId, reversedAt: null,
        invoiceId: { in: receipt.allocations.map((a) => a.invoiceId) },
        status: { in: ['MATCHED_26AS', 'CLAIMED'] },
      },
    })
    if (claimed) {
      throw new AppError(
        `The TDS behind ${receipt.number} is already ${claimed.status === 'CLAIMED' ? 'claimed' : 'matched to Form 26AS'}. ` +
        'Cancelling it would leave the books disagreeing with a filed position — raise it with the CA instead.',
      )
    }

    const entries = await tx.journalEntry.findMany({
      where: { companyId: ctx.companyId, sourceType: 'RECEIPT', sourceId: receipt.id, reversalOfId: null },
    })
    for (const e of entries) await reverseJournal(ctx, e.id, on, reason, tx)

    for (const a of receipt.allocations) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } })
      const received = Decimal.max(new Decimal(inv.amountReceived.toString()).minus(a.amount.toString()), ZERO)
      const credited = Decimal.max(new Decimal(inv.tdsCredited.toString()).minus(a.tdsAmount.toString()), ZERO)

      // 🔴 Back to OVERDUE or SENT, never to DRAFT. The invoice was issued and its number is
      // out in the world; a cancelled receipt does not un-issue it.
      const settled = received.plus(credited)
      const status = settled.gte(new Decimal(inv.grandTotal.toString()).minus('0.5'))
        ? 'PAID'
        : settled.gt(0)
          ? 'PARTIALLY_PAID'
          : inv.dueDate < on ? 'OVERDUE' : 'SENT'

      await tx.invoice.update({
        where: { id: inv.id },
        data: { amountReceived: received.toFixed(2), tdsCredited: credited.toFixed(2), status },
      })
    }

    await tx.tdsReceivable.updateMany({
      where: {
        companyId: ctx.companyId, reversedAt: null,
        invoiceId: { in: receipt.allocations.map((a) => a.invoiceId) },
        status: 'BOOKED',
      },
      data: { reversedAt: new Date() },
    })

    const cancelled = await tx.receipt.update({
      where: { id: receipt.id },
      data: { cancelledAt: new Date(), cancelReason: reason.trim() },
    })

    // the bank line that produced it, if any, goes back in the queue to be matched again
    await tx.bankTransaction.updateMany({
      where: { companyId: ctx.companyId, receiptId: receipt.id },
      data: { status: 'UNMATCHED', receiptId: null, matchReason: null, confidence: null },
    })

    await audit(ctx, { entity: 'Receipt', entityId: receipt.id, action: 'CANCEL', after: { reason } }, tx)
    return cancelled
  })
}

/* ── bill payments ───────────────────────────────────────────────────────────── */

export async function cancelBillPayment(ctx: RequestContext, paymentId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'bills', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  return prisma.$transaction(async (tx) => {
    const payment = await tx.billPayment.findFirst({
      where: { id: paymentId, bill: { companyId: ctx.companyId } },
      include: { bill: true },
    })
    if (!payment) throw new NotFound('Payment not found')
    if (payment.cancelledAt) throw new AppError('That payment is already cancelled')

    const entries = await tx.journalEntry.findMany({
      where: { companyId: ctx.companyId, sourceType: 'BILL_PAYMENT', sourceId: payment.id, reversalOfId: null },
    })
    for (const e of entries) await reverseJournal(ctx, e.id, on, reason, tx)

    const paid = Decimal.max(new Decimal(payment.bill.amountPaid.toString()).minus(payment.amount.toString()), ZERO)
    const owed = new Decimal(payment.bill.grandTotal.toString()).minus(payment.bill.tdsAmount.toString())

    await tx.vendorBill.update({
      where: { id: payment.billId },
      data: {
        amountPaid: paid.toFixed(2),
        status: paid.gte(owed.minus('0.5')) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'APPROVED',
      },
    })
    await tx.billPayment.update({ where: { id: payment.id }, data: { cancelledAt: new Date() } })

    await tx.bankTransaction.updateMany({
      where: { companyId: ctx.companyId, billPaymentId: payment.id },
      data: { status: 'UNMATCHED', billPaymentId: null, matchReason: null, confidence: null },
    })

    await audit(ctx, { entity: 'BillPayment', entityId: payment.id, action: 'CANCEL', after: { reason } }, tx)
    return { ok: true }
  })
}

/* ── expenses ────────────────────────────────────────────────────────────────── */

/**
 * Cancel an expense.
 *
 * 🔴 This reverses its INPUT CREDIT too, and that is the point. An expense booked in error
 * does not merely overstate cost — if its GST was claimed, the credit was taken against tax
 * that was never incurred. Reversing the journal entry unwinds both together, which is why
 * the correction has to go through the ledger rather than editing the expense row.
 */
export async function cancelExpense(ctx: RequestContext, expenseId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'expenses.all', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({ where: { id: expenseId, companyId: ctx.companyId } })
    if (!expense) throw new NotFound('Expense not found')
    if (expense.cancelledAt) throw new AppError('That expense is already cancelled')

    const entries = await tx.journalEntry.findMany({
      where: { companyId: ctx.companyId, sourceType: 'EXPENSE', sourceId: expense.id, reversalOfId: null },
    })
    for (const e of entries) await reverseJournal(ctx, e.id, on, reason, tx)

    const cancelled = await tx.expense.update({
      where: { id: expense.id },
      data: { cancelledAt: new Date(), cancelReason: reason.trim(), status: 'REJECTED' },
    })
    await audit(ctx, { entity: 'Expense', entityId: expense.id, action: 'CANCEL', after: { reason } }, tx)
    return cancelled
  })
}

/* ── bank matches ────────────────────────────────────────────────────────────── */

/**
 * Put a wrongly matched bank line back in the queue.
 *
 * 🔴 The matcher is a suggestion engine, so a wrong match is an ordinary outcome rather than
 * an exceptional one — and until now there was no way back from one. Whatever the match
 * created is reversed through its own cancellation path, so unmatching a receipt restores the
 * invoice exactly as cancelling that receipt by hand would.
 */
export async function unmatchBankTransaction(ctx: RequestContext, txnId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'banking.post', 'approve')
  requireReason(reason)

  const txn = await prisma.bankTransaction.findFirst({ where: { id: txnId, companyId: ctx.companyId } })
  if (!txn) throw new NotFound('Bank transaction not found')
  if (txn.status !== 'MATCHED' && txn.status !== 'EXCLUDED') {
    throw new AppError('That line is not matched')
  }

  if (txn.receiptId) {
    await cancelReceipt(ctx, txn.receiptId, reason, on)
  } else if (txn.billPaymentId) {
    await cancelBillPayment(ctx, txn.billPaymentId, reason, on)
  } else if (txn.journalEntryId) {
    await assertPostable(ctx.companyId, on)
    await reverseJournal(ctx, txn.journalEntryId, on, reason)
  }

  // an EXCLUDED contra pair has no document behind it — both legs simply go back
  const restored = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      status: 'UNMATCHED',
      receiptId: null, billPaymentId: null, journalEntryId: null,
      matchReason: null, confidence: null,
    },
  })

  await audit(ctx, { entity: 'BankTransaction', entityId: txn.id, action: 'CANCEL', after: { reason } })
  return restored
}
