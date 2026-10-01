# 40 · Corrections

**Status: done.** 469 tests (263 unit + 206 integration), typecheck and lint clean,
production build passes.

---

## 1. 🔴 How this was found

A survey, not a wishlist. **Ten document types post journal entries. Only two could be
cancelled** — invoices and vendor bills.

Receipts, bill payments, expenses, payroll runs, TDS challans and bank matches were all
**permanent once posted**. The bank matcher is the sharpest case: it is a suggestion engine,
so a wrong match is an ordinary outcome rather than an exceptional one — and there was no way
back from one.

## 2. The three rules every correction follows

They are the system's existing rules, applied where they were missing:

1. 🔴 **Reverse, never delete.** A new journal entry undoes the old one and **both stay**. The
   database refuses a hard delete on financial tables anyway, and rightly so.
2. 🔴 **The period must be open.** A reversal is a posting like any other; letting it into a
   locked month would silently change a filed return. Every path calls `assertPostable`.
3. 🔴 **A reason, recorded.** It is the only record of *why* the figures moved.

Numbers are never reused. A cancelled receipt keeps `ADPR/26-27/0001`, exactly as a cancelled
invoice keeps its number under Rule 46 — a gap in a series is harder to explain than a
reversal.

## 3. 🔴 What a correction must refuse

**TDS already matched to Form 26AS, or claimed.**

At that point the credit is no longer only our record: it has been reconciled against what
the government says was deducted, and may already have been set off in a return. Quietly
unwinding it would leave the books disagreeing with a **filed position**, and the
disagreement would surface at assessment rather than today.

> The TDS behind ADPR/26-27/0001 is already matched to Form 26AS. Cancelling it would leave
> the books disagreeing with a filed position — raise it with the CA instead.

A receipt that wrong needs a conversation, not a button.

## 4. Putting an invoice back

Cancelling a receipt restores `amountReceived`, `tdsCredited` and the status — 🔴 **to SENT or
OVERDUE, never to DRAFT.** The invoice was issued and its number is out in the world; a
cancelled receipt does not un-issue it.

The TdsReceivable row is **reversed, not deleted** (`reversedAt`), mirroring how
`TdsDeduction` was handled in phase 3 for exactly the same reason.

And the bank line that produced it goes **back into the reconciliation queue** to be matched
again.

## 5. 🔴 Cancelling an expense reverses its input credit

This is the part worth stating plainly. An expense booked in error does not merely overstate
cost — if its GST was claimed, **credit was taken against tax that was never incurred**.
Reversing the journal entry unwinds both together, which is why the correction goes through
the ledger rather than editing the expense row.

A test asserts the GST position returns to exactly where it was.

## 6. 🔴 The aggregates had to follow

Adding cancellation is only half the change. Every figure that sums these documents had to
learn to exclude the cancelled ones, or **money that was reversed would still read as
collected**:

- the dashboard's collected and TDS-credited totals
- the receipts screen's totals — though cancelled receipts stay **in the list**, struck
  through, because the number was allocated and the reversal is part of the record
- the expense list, where a cancelled expense would otherwise double against its own reversal

This is the kind of change that looks finished when the cancel button works and is wrong
everywhere else.

## 7. What is proven

The decisive test is not that cancelling succeeds — it is that the ledger ends up **exactly
where it started**: the trial balance still balances, the bank account's closing balance
matches its value before the receipt existed, and the journal holds both entries with one
marked as the reversal of the other.

## 8. Still open

- **Payroll runs and TDS challans** still cannot be cancelled. Both are rarer and both have
  more downstream consequences (a filed 24Q, a deposited challan), so they want their own
  thinking rather than the same pattern applied blindly.
- **Unmatching a bank line has a service but no button.** `unmatchBankTransaction` works and
  is the path a wrong match should take; the reconcile screen only lists unmatched lines, so
  there is nowhere to click it yet.
- **Advance receipts** — money in before an invoice exists — still have no manual path.
