# 44 · Recording a GST filing

**Status: done.** 512 tests (285 unit + 227 integration), typecheck and lint clean,
production build passes.

Closes three loose ends at once, all of them documented earlier.

---

## 1. 🔴 A model that existed and a comment that lied

`GstReturnPeriod` has been in the schema since phase 2 with `filedOn`, `arn` and a status of
OPEN / PREPARED / FILED. **Nothing ever wrote to it** — the same shape as the `CreditNote`
table in docs/42.

Worse, `accounting/period.ts` carried this:

> A filed GST return advances lockedUpTo automatically.

That was never true. Nothing filed returns, so nothing advanced the lock. The comment has
been corrected to describe what the code now actually does, rather than what someone intended
it to.

## 2. What follows from recording a filing

1. The **compliance calendar** can finally mark GSTR-1 and GSTR-3B as done. Docs/43 listed
   this as open: *"filing on the portal leaves no fact in this system"*.
2. There is a **filing history with ARNs**, to reconcile against the portal.
3. 🔴 **The period locks.** Docs/37 flagged this as the natural follow-on and it is the one
   that matters.

## 3. 🔴 Why filing must lock the period

The moment a return is filed, the figures in it are a statement to the government. A change
to anything dated inside that period — a late invoice, a corrected expense, a reversed
receipt — makes the filed return wrong, and **nothing says so**. The disagreement surfaces
at a notice, months later, when nobody remembers what changed.

So recording a filing advances `lockedUpTo` to the end of that period. Every posting path in
the system already calls the same guard, so this is enforced for invoices, bills, payroll and
bank matches alike without touching any of them.

Only ever forward: a later filing never un-locks an earlier one.

## 4. 🔴 The figures are snapshotted, not read live

What was filed is a **historical fact**, and it is what a notice will be compared against.
Reading the books live would mean the "filed" figures quietly tracked every later correction
— and the one question that matters at assessment, *"what did we actually report?"*, would
become unanswerable.

So output tax, input tax, RCM and the net payable are frozen at the moment of filing.

## 5. Removing a record does NOT unlock

🔴 Deliberately. The return may genuinely have been filed on the portal even if this record
was wrong, and quietly reopening a month is precisely how a filed return stops matching the
books. The service says so in its result:

> The period stays locked — unlock it separately if that is really intended.

Unlocking remains the explicit, reasoned act built in docs/37.

## 6. Smaller things it refuses

- **Filing the same return twice.** A return is filed once; a change goes into a later period
  as an amendment, never by re-filing. The message says that rather than just "duplicate".
- **A malformed ARN**, rather than storing nonsense that will not match the portal.
- **A period that is not a filing period** for the year — which also catches a monthly label
  entered on a QRMP filer.

## 7. A bug caught while wiring the calendar

The calendar keyed its GST periods **by date**; a filing record carries a **period label**
(`2026-Q1`). They would never have matched, so a filed return would have gone on showing as
outstanding forever — the exact failure this module exists to fix. Both sides now use
`periodFor`, which is the single source for period bounds, and two local helpers that
duplicated it were deleted.

## 8. Still open

- **Nothing records the GST payment itself** — `GstReturnPeriod` holds the net payable, but
  the challan and the cash ledger movement are not captured, so a filed-but-unpaid return
  looks settled.
- **Amendments** (filing a correction in a later period) have no representation.
- Carried forward: credit-note PDF, debit notes, vendor and project edit pages, the unmatch
  button, payroll and challan cancellation.
