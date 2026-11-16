import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { reverseJournal } from './journal'
import { assertPostable } from './period'
import { wouldContradictFiling, formForSectionCode } from '@/server/services/tax/tds-filing'
import { periodFor } from '@/server/services/tax/periods'

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

    /**
     * 🔴 An advance that has been refunded cannot be cancelled — docs/69.
     *
     * The refund voucher is a document in its own right: it carries a number from its own
     * series, it went to the customer under rule 51, and it is in GSTR-1 table 11B. Cancelling
     * the receipt behind it would leave that voucher refunding an advance the books say never
     * arrived. Cancel the voucher first — `cancelRefundVoucher` — and then the receipt.
     *
     * This used to happen silently and the other way round: the refund's journal entry was
     * filed under the receipt's id, so cancelling the receipt reversed the refund too, while
     * the voucher stayed live and stayed in the return.
     */
    const refunds = await tx.refundVoucher.findMany({
      where: { companyId: ctx.companyId, receiptId: receipt.id, cancelledAt: null },
      select: { number: true },
    })
    if (refunds.length > 0) {
      throw new AppError(
        `${receipt.number} has been refunded on ${refunds.map((r) => r.number).join(', ')}. ` +
        'A refund voucher is a document of its own and the customer has it — cancel it first, then this receipt.',
      )
    }

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
      const inv = await tx.invoice.findUniqueOrThrow({ where: { companyId: ctx.companyId, id: a.invoiceId } })
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
        where: { companyId: ctx.companyId, id: inv.id },
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
      where: { companyId: ctx.companyId, id: receipt.id },
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
      where: { companyId: ctx.companyId, id: payment.billId },
      data: {
        amountPaid: paid.toFixed(2),
        status: paid.gte(owed.minus('0.5')) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'APPROVED',
      },
    })
    await tx.billPayment.update({ where: { companyId: ctx.companyId, id: payment.id }, data: { cancelledAt: new Date() } })

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
      where: { companyId: ctx.companyId, id: expense.id },
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
    where: { companyId: ctx.companyId, id: txn.id },
    data: {
      status: 'UNMATCHED',
      receiptId: null, billPaymentId: null, journalEntryId: null,
      matchReason: null, confidence: null,
    },
  })

  await audit(ctx, { entity: 'BankTransaction', entityId: txn.id, action: 'CANCEL', after: { reason } })
  return restored
}

/* ── payroll ─────────────────────────────────────────────────────────────────── */

/**
 * Cancel a payroll run — docs/50.
 *
 * 🔴 Deliberately left out of docs/49, because a payroll run is not one document. Hanging off
 * it are payslips, a salary-payment entry, a s.192 deduction per employee, the profession tax
 * for the half-year, and — the part that matters — a TDS liability that may already have been
 * deposited with the government and reported against the employee's PAN.
 *
 * So it refuses in two places, and both refusals are about something that has left the
 * building:
 *
 *   1. **The TDS is on a challan.** The money is with the government. Cancelling the run here
 *      would leave a deposit with nothing behind it and the employee credited for tax that no
 *      longer exists in our books.
 *   2. **The quarter's 24Q is filed.** Each deduction has been reported against that
 *      employee's PAN and appears in their Form 26AS. They will claim it. Unsaying it here
 *      produces a mismatch the employee discovers at assessment, not us.
 *
 * What it does do: reverse the run's journal, reverse the salary payment if one was posted,
 * mark every s.192 deduction reversed so it leaves the challan queue and the return, and keep
 * the run and its payslips on file marked CANCELLED.
 */
export async function cancelPayrollRun(ctx: RequestContext, runId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'payroll', 'approve')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, companyId: ctx.companyId }, include: { payslips: true },
  })
  if (!run) throw new NotFound('Payroll run not found')
  if (run.cancelledAt) throw new AppError('That payroll run is already cancelled')
  if (run.status === 'DRAFT') throw new AppError('A draft run has posted nothing — there is nothing to reverse')

  const deductions = await prisma.tdsDeduction.findMany({
    where: { companyId: ctx.companyId, documentType: 'PAYROLL', documentId: run.id, reversedAt: null },
  })

  const deposited = deductions.filter((d) => d.challanId)
  if (deposited.length > 0) {
    throw new AppError(
      `The s.192 TDS on this run has already been deposited — ${deposited.length} deduction${deposited.length === 1 ? '' : 's'} ` +
      'sit on a challan. The government has that money and the employees are credited with it. ' +
      'Cancel the challan first if it was also wrong, and talk to the CA before unwinding a deposit.',
    )
  }

  // 🔴 Not "the quarter is filed, so nothing in it may be touched". A July run nobody noticed
  // until November was in none of the Q2 return's figures, and cancelling it contradicts
  // nothing. What may not happen is taking the quarter BELOW what was reported.
  for (const quarter of new Set(deductions.map((d) => d.quarter))) {
    const removing = deductions
      .filter((d) => d.quarter === quarter)
      .reduce((a, d) => a.plus(d.tdsAmount.toString()), ZERO)

    const check = await wouldContradictFiling({
      companyId: ctx.companyId, quarter, formType: '24Q', removing, side: 'deducted',
    })
    if (check.contradicts) {
      throw new AppError(
        `24Q for Q${quarter} was filed on ${check.filedOn!.toISOString().slice(0, 10)} reporting ` +
        `${check.reported!.toFixed(2)} of salary TDS. Reversing this run would leave ${check.after!.toFixed(2)} ` +
        'in the books against it — and every deduction in that return is reported against the employee’s PAN ' +
        'and already shows in their Form 26AS. They would be claiming tax this company no longer says it deducted. ' +
        'The correction is a C3 statement against that return — record it on the TDS screen and this becomes ' +
        'reversible, because the return will no longer claim it.',
      )
    }
  }

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceType: 'PAYROLL', sourceId: run.id, reversalOfId: null },
    orderBy: { entryNo: 'asc' },
  })

  return prisma.$transaction(async (tx) => {
    // 🔴 BOTH entries, where the salaries were also paid. Cancelling the run says the whole
    // thing was recorded in error; leaving the payment posted would claim money left the bank
    // for a run that no longer exists. If the money really did move, the bank line comes back
    // as unmatched in reconciliation — which is exactly where a payment with no document belongs.
    for (const e of entries) {
      await reverseJournal(ctx, e.id, on, reason, tx)
    }

    await tx.tdsDeduction.updateMany({
      where: { companyId: ctx.companyId, documentType: 'PAYROLL', documentId: run.id, reversedAt: null },
      data: { reversedAt: on },
    })

    const cancelled = await tx.payrollRun.update({
      where: { companyId: ctx.companyId, id: run.id },
      data: { status: 'CANCELLED', cancelledAt: on, cancelReason: reason.trim() },
    })

    await audit(ctx, {
      entity: 'PayrollRun', entityId: run.id, action: 'CANCEL',
      before: { status: run.status, net: run.netTotal.toString() },
      after: { reason: reason.trim(), entriesReversed: entries.length, deductionsReversed: deductions.length },
    }, tx)

    return cancelled
  })
}

/* ── TDS challans ────────────────────────────────────────────────────────────── */

/**
 * Cancel a TDS challan — docs/50.
 *
 * 🔴 This does not ask the government for the money back. It says the challan was recorded
 * here in error — a wrong BSR code, the wrong deductions attached, a duplicate entry. The
 * deposit itself, if it really happened, is still a bank line waiting to be matched.
 *
 * Refused once the quarter's return is filed, because the challan is quoted in it: the
 * deductees' 26AS entries are backed by that CIN, and withdrawing it leaves their credit
 * unsupported.
 */
export async function cancelTdsChallan(ctx: RequestContext, challanId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'tax', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  const challan = await prisma.tdsChallan.findFirst({
    where: { id: challanId, companyId: ctx.companyId }, include: { deductions: true },
  })
  if (!challan) throw new NotFound('Challan not found')
  if (challan.cancelledAt) throw new AppError('That challan is already cancelled')

  const form = formForSectionCode(challan.sectionCode ?? '194J')
  const check = await wouldContradictFiling({
    companyId: ctx.companyId, quarter: challan.quarter, formType: form,
    removing: new Decimal(challan.amount.toString()), side: 'deposited',
  })
  if (check.contradicts) {
    throw new AppError(
      `${form} for Q${challan.quarter} was filed on ${check.filedOn!.toISOString().slice(0, 10)} reporting ` +
      `${check.reported!.toFixed(2)} as deposited. Withdrawing this challan would leave ${check.after!.toFixed(2)} ` +
      'behind it. The deductees’ credit in their Form 26AS is backed by this CIN — withdrawing it here would ' +
      'leave that credit unsupported. Record a C2 or C9 correction statement against that return first — ' +
      'this becomes reversible once the return no longer reports the deposit.',
    )
  }

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceType: 'TDS_CHALLAN', sourceId: challan.id, reversalOfId: null },
  })

  return prisma.$transaction(async (tx) => {
    for (const e of entries) {
      await reverseJournal(ctx, e.id, on, reason, tx)
    }

    // 🔴 The deductions go back to OUTSTANDING, not to reversed. They were real deductions
    // from real payments; what was wrong is the record of depositing them. They reappear in
    // the challan queue, with their interest clock still running from the day they were
    // deducted — which is the true position.
    await tx.tdsDeduction.updateMany({
      where: { companyId: ctx.companyId, challanId: challan.id }, data: { challanId: null },
    })

    const cancelled = await tx.tdsChallan.update({
      where: { companyId: ctx.companyId, id: challan.id },
      data: { cancelledAt: on, cancelReason: reason.trim() },
    })

    await audit(ctx, {
      entity: 'TdsChallan', entityId: challan.id, action: 'CANCEL',
      before: { cin: challan.cin, amount: challan.amount.toString(), deductions: challan.deductions.length },
      after: { reason: reason.trim() },
    }, tx)

    return cancelled
  })
}

/* ── credit notes ────────────────────────────────────────────────────────────── */

/**
 * The GST return that would have reported a document dated `on`.
 *
 * A credit note belongs to the period it was issued in, and that period's return is where it
 * was declared — GSTR-1 for a credit note, GSTR-3B for a set-off.
 */
async function filedReturnFor(companyId: string, on: Date, returnType: 'GSTR1' | 'GSTR3B') {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId }, select: { gstFilingFrequency: true },
  })
  const period = periodFor(on, company.gstFilingFrequency)
  const filed = await prisma.gstReturnPeriod.findFirst({
    where: { companyId, periodLabel: period.label, returnType, status: 'FILED' },
  })
  return { period, filed }
}

/**
 * Cancel a credit note — docs/51.
 *
 * 🔴 Refused once the GSTR-1 that declared it has been filed. A credit note in table 9B is
 * not only our record: it has reached the customer's GSTR-2B and reduced the input credit
 * they may claim. Withdrawing it here would leave them holding a reversal we no longer say we
 * issued, and they find out at reconciliation.
 *
 * A commercial credit note (docs/48) is never in GSTR-1 at all, so nothing reported it and the
 * filing does not block it.
 */
export async function cancelCreditNote(ctx: RequestContext, noteId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'invoices.cancel', 'approve')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  const note = await prisma.creditNote.findFirst({
    where: { id: noteId, companyId: ctx.companyId },
    include: { invoice: true },
  })
  if (!note) throw new NotFound('Credit note not found')
  if (note.cancelledAt) throw new AppError('That credit note is already cancelled')

  if (note.gstAdjusted) {
    const { period, filed } = await filedReturnFor(ctx.companyId, note.date, 'GSTR1')
    if (filed) {
      throw new AppError(
        `GSTR-1 for ${period.label} was filed on ${filed.filedOn!.toISOString().slice(0, 10)}, declaring ${note.number} ` +
        'in table 9B. It has reached the customer’s GSTR-2B and reduced the credit they may claim — withdrawing it here ' +
        'would leave them holding a reversal this company no longer says it issued. Amend the invoice in a later ' +
        'return instead, or issue a debit note.',
      )
    }
  }

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceType: 'CREDIT_NOTE', sourceId: note.id, reversalOfId: null },
  })

  return prisma.$transaction(async (tx) => {
    for (const e of entries) {
      await reverseJournal(ctx, e.id, on, reason, tx)
    }

    // 🔴 Put the invoice's status back. Crediting an invoice in full marks it PAID
    // (docs/42) — leaving that in place would show an invoice as settled by a credit note
    // that no longer exists, and it would drop out of the ageing that should be chasing it.
    if (note.invoice) {
      const inv = note.invoice
      const otherCredits = await tx.creditNote.aggregate({
        where: { companyId: ctx.companyId, invoiceId: inv.id, cancelledAt: null, id: { not: note.id } },
        _sum: { grandTotal: true },
      })
      const settled = new Decimal(inv.amountReceived.toString())
        .plus(inv.tdsCredited.toString())
        .plus(otherCredits._sum.grandTotal?.toString() ?? '0')
      const grand = new Decimal(inv.grandTotal.toString())

      const status = settled.gte(grand.minus('0.5'))
        ? 'PAID' as const
        : settled.gt(0) ? 'PARTIALLY_PAID' as const : inv.dueDate < on ? 'OVERDUE' as const : 'SENT' as const
      await tx.invoice.update({ where: { companyId: ctx.companyId, id: inv.id }, data: { status } })
    }

    const cancelled = await tx.creditNote.update({
      where: { companyId: ctx.companyId, id: note.id },
      data: { cancelledAt: on, cancelReason: reason.trim() },
    })

    await audit(ctx, {
      entity: 'CreditNote', entityId: note.id, action: 'CANCEL',
      before: { number: note.number, grandTotal: note.grandTotal.toString(), against: note.invoice?.number ?? null },
      after: { reason: reason.trim() },
    }, tx)

    return cancelled
  })
}

/* ── GST set-offs ────────────────────────────────────────────────────────────── */

/**
 * Cancel a GST set-off — docs/51.
 *
 * 🔴 Refused once the GSTR-3B it discharged has been filed, because the set-off IS table 6.1
 * of that return: the credit utilised and the cash debited are what was declared, and the
 * portal has already debited the real ledgers to match. Reversing it here would leave our
 * electronic ledgers disagreeing with the portal's — which is the one place in this system
 * where our figures are supposed to be a mirror of somebody else's.
 *
 * Otherwise it puts everything back: the liability returns, the credit ledger is restored,
 * and the cash ledger goes back to holding the money — which is the true position, because
 * money that was never debited is still sitting there.
 */
export async function cancelGstSetOff(ctx: RequestContext, setOffId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'tax', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  const setOff = await prisma.gstSetOff.findFirst({ where: { id: setOffId, companyId: ctx.companyId } })
  if (!setOff) throw new NotFound('Set-off not found')
  if (setOff.cancelledAt) throw new AppError('That set-off is already cancelled')

  const filed = await prisma.gstReturnPeriod.findFirst({
    where: { companyId: ctx.companyId, periodLabel: setOff.periodLabel, returnType: 'GSTR3B', status: 'FILED' },
  })
  if (filed) {
    throw new AppError(
      `GSTR-3B for ${setOff.periodLabel} was filed on ${filed.filedOn!.toISOString().slice(0, 10)}. ` +
      'This set-off is table 6.1 of that return — the portal has debited the real electronic ledgers to match it. ' +
      'Reversing it here would leave this system’s ledgers disagreeing with the portal’s, which is the one place ' +
      'they are meant to mirror each other.',
    )
  }

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceType: 'GST_SET_OFF', sourceId: setOff.id, reversalOfId: null },
  })

  return prisma.$transaction(async (tx) => {
    for (const e of entries) {
      await reverseJournal(ctx, e.id, on, reason, tx)
    }

    const cancelled = await tx.gstSetOff.update({
      where: { companyId: ctx.companyId, id: setOff.id },
      data: { cancelledAt: on, cancelReason: reason.trim() },
    })

    await audit(ctx, {
      entity: 'GstSetOff', entityId: setOff.id, action: 'CANCEL',
      before: { period: setOff.periodLabel, byCredit: setOff.creditUsed.toString(), inCash: setOff.cashUsed.toString() },
      after: { reason: reason.trim() },
    }, tx)

    return cancelled
  })
}

/* ── refund vouchers ─────────────────────────────────────────────────────────── */

/**
 * Cancel a refund voucher — docs/69, and the member docs/51's family was missing.
 *
 * It was modelled for since docs/65 — `cancelledAt`, `cancelReason`, and a GSTR-1 that already
 * excludes cancelled ones — and could not be written, because the voucher's journal entry was
 * filed under the advance's identity and nothing could find it.
 *
 * 🔴 Refused once the GSTR-1 that declared it has been filed, but **not for the credit note's
 * reason**. A credit note sits in table 9B, reaches the customer's GSTR-2B and reduces the
 * credit they may claim; a refund voucher sits in 11B, which is an adjustment of the
 * supplier's own advances and has no counterpart on the recipient's side at all. What filing
 * it does is tell the government that tax declared in an earlier period has been taken back.
 * Withdrawing that here would put the liability back into a period whose return is closed,
 * and the first anybody would know is a demand. The remedy is the same shape — report it in a
 * later return — but saying "the customer is holding a reversal" would be untrue, and a
 * refusal that gives the wrong reason sends somebody to fix the wrong thing.
 */
export async function cancelRefundVoucher(ctx: RequestContext, voucherId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'receipts', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  const voucher = await prisma.refundVoucher.findFirst({
    where: { id: voucherId, companyId: ctx.companyId },
    include: { receipt: { select: { number: true } }, customer: { select: { name: true } } },
  })
  if (!voucher) throw new NotFound('Refund voucher not found')
  if (voucher.cancelledAt) throw new AppError(`Refund voucher ${voucher.number} is already cancelled`)

  const { period, filed } = await filedReturnFor(ctx.companyId, voucher.date, 'GSTR1')
  if (filed) {
    throw new AppError(
      `GSTR-1 for ${period.label} was filed on ${filed.filedOn!.toISOString().slice(0, 10)}, declaring ${voucher.number} ` +
      'in table 11B as an adjustment of advances. Withdrawing it here would put the tax back into a period that is ' +
      'closed, with nothing in any return to say so. Report the correction in a later return instead.',
    )
  }

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceType: 'REFUND_VOUCHER', sourceId: voucher.id, reversalOfId: null },
  })

  return prisma.$transaction(async (tx) => {
    for (const e of entries) await reverseJournal(ctx, e.id, on, reason, tx)

    /**
     * Nothing else to put back. The advance's available balance is DERIVED — `advanceAvailable`
     * counts only refunds with `cancelledAt: null` — so cancelling the voucher restores it by
     * itself, and there is no stored figure to drift.
     */
    const cancelled = await tx.refundVoucher.update({
      where: { companyId: ctx.companyId, id: voucher.id },
      data: { cancelledAt: on, cancelReason: reason.trim() },
    })

    await audit(ctx, {
      entity: 'RefundVoucher', entityId: voucher.id, action: 'CANCEL',
      before: { number: voucher.number, against: voucher.receipt.number, amount: voucher.amount.toString() },
      after: { reason: reason.trim() },
    }, tx)

    return cancelled
  })
}

/* ── advance tax ─────────────────────────────────────────────────────────────── */

/**
 * Cancel an advance-tax payment — docs/72, closing the gap docs/71 opened.
 *
 * 🔴 Written in the module AFTER the one that modelled it, deliberately. `cancelRefundVoucher`
 * sat as a nullable column and a note in "still open" for four modules (docs/65 §7 → docs/69),
 * and by the time anybody came back to it the postings had been filed under the wrong
 * identity. A modelled-but-unserviced field is the same gap as a service with no caller; this
 * one is closed while the shape of it is still in somebody's head.
 *
 * There is no filing to refuse against. Advance tax is not reported in a return — it appears
 * in the ITR as tax already paid, and until that return is filed a challan entered in error is
 * simply an entry in these books. The period lock is the only guard, and it is the right one:
 * what must not happen is a reversal landing in a closed year.
 */
export async function cancelAdvanceTaxPayment(
  ctx: RequestContext, paymentId: string, reason: string, on = new Date(),
) {
  assertCan(ctx.role, 'tax', 'write')
  requireReason(reason)
  await assertPostable(ctx.companyId, on)

  const payment = await prisma.advanceTaxPayment.findFirst({
    where: { id: paymentId, companyId: ctx.companyId },
  })
  if (!payment) throw new NotFound('Advance tax payment not found')
  if (payment.cancelledAt) throw new AppError('That payment is already cancelled')

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceType: 'ADVANCE_TAX', sourceId: payment.id, reversalOfId: null },
  })

  return prisma.$transaction(async (tx) => {
    for (const e of entries) await reverseJournal(ctx, e.id, on, reason, tx)

    const cancelled = await tx.advanceTaxPayment.update({
      where: { companyId: ctx.companyId, id: payment.id },
      data: { cancelledAt: on, cancelReason: reason.trim() },
    })

    await audit(ctx, {
      entity: 'AdvanceTaxPayment', entityId: payment.id, action: 'CANCEL',
      before: { amount: payment.amount.toString(), cin: payment.cin },
      after: { reason: reason.trim() },
    }, tx)

    return cancelled
  })
}
