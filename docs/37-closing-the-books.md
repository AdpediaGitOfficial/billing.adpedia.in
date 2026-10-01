# 37 · Closing the books

**Status: done.** 434 tests (253 unit + 181 integration), typecheck and lint clean,
production build passes.

Period locking and the year-end close — the thing that makes this a ledger rather than a
running tally.

---

## 1. 🔴 The guard existed with nothing to trigger it

`assertPostable()` has always enforced both a period lock and a closed year, and **every**
posting path calls it — invoices, bills, payroll, expenses, bank matches. But nothing in the
system ever *set* `lockedUpTo` or `status: CLOSED`, and the `period.lock` capability was
granted to the owner and never used.

So in practice any date in an open year was writable forever, **including a month whose GST
return had already been filed**. The lock was a door with no handle.

## 2. Locking a period

Lock a month once its return is filed — that is the point after which changing it would
quietly make the filed return wrong.

🔴 **Moving a lock backwards is refused on the ordinary path.** It silently reopens filed
months, so it is a separate `unlock` action that **demands a reason of at least ten
characters**, which lands in the audit log. The person reading it later is an auditor.

## 3. The closing preflight

Closing is not reversible in any ordinary sense, so the checks run first and the blocking
ones genuinely block:

| Check | Blocks | Why |
|---|---|---|
| Trial balance balances | ✅ | an unbalanced ledger must not be frozen |
| No draft invoices | ✅ | 🔴 a draft is **stranded**: its number comes from this year's series, but it could only be posted into the next |
| No draft bills | ✅ | their input credit is lost if the year closes first |
| A following year exists | ✅ | corrections need somewhere to go |
| Bank reconciled | — | **advisory**: an unmatched line does not make the books wrong, it makes them unverified |

The distinction matters. Stopping a year-end over an unreconciled bank line would be the
software overruling a judgement that belongs to the person closing.

## 4. The closing entry

One entry, dated the last day of the year, that zeroes every income and expense account and
books the difference to **3100 Retained Earnings**.

🔴 **Nothing posts to 3200 Current Year Profit.** It stays a reporting bucket — sweeping into
it would stack every closed year's profit in one account nobody can read.

### The interaction that had to be got right

The balance sheet has been **calculating** the profit into equity since phase 8, because the
books never closed. Once the entry exists the profit is a *posted* balance — and if the
derived line were still added on top, **assets would exceed liabilities and equity by exactly
the profit**.

It works out, and not by luck: `profitAndLoss` reads *movement*, and after the closing entry
the income and expense movement nets to zero, so the derived figure becomes zero by itself.
Four assertions hold it: the statement still balances, the difference is `0`,
`currentYearProfit` is `0`, and **no derived line remains**.

## 5. Reopening reverses, never deletes

🔴 Deleting the closing entry would erase the evidence that the year was ever closed.
`reopenYear` posts a **reversal** through the existing `reverseJournal`, so the journal keeps
both and an auditor can see exactly what happened and when. It demands a reason too.

## 6. 🔴 Opening the next year — and the trap in it

`DocumentSeries` is **per financial year**. Creating the next year without carrying the series
across would break invoice numbering **on 1 April**: the first invoice of the new year has
nothing to draw a number from and simply fails, with a client waiting.

The series are copied with `nextSeq` reset to **1** — the sequence restarts each year, so it
is `ADP/27-28/0001`, never continuing last year's count. The pattern carries over unchanged
because it contains `{FY}`, which renders from the new year's own label.

**A bug this phase's own test caught:** the first implementation copied from the *latest*
year, which may itself have been created bare. Feeding a series-less year in as the template
produced another year with no numbering — and the failure would only have surfaced on the
first invoice of April. It now takes the most recent year that actually **has** series.

## 7. Confirmation by typing

Closing is typed out in full — `CLOSE 2026-27` — not clicked. It is a once-a-year action that
locks an entire year, and an accidental click during a scroll is exactly the mistake to
design out.

## 8. Still open

- **No UI to edit a financial year** beyond creating the next one — dates and labels are
  seeded.
- **Closing does not carry forward opening balances** as explicit entries; the balance sheet
  reads cumulative movement instead, which is equivalent and simpler, but a CA expecting a
  formal opening-balance journal in the new year will not find one.
- **GST return filing does not advance the lock automatically** — the comment in
  `period.ts` says it should, and that wiring is not in yet.
