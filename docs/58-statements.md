# 58 · Statements that can leave the screen

**Status: done.** 776 tests (353 unit + 423 integration), typecheck and lint clean,
production build passes.

The P&L and the balance sheet have existed since docs/36 and could only ever be looked at.
There was CSV for seven reports and no PDF for any of them, and the two drill-throughs an
auditor actually asks for — the journal and an account ledger — had no download at all.

---

## 1. 🔴 A statement that does not say whether it can still change

This is the one that mattered, and every export before today was silent about it.

A profit figure for the year to date, emailed to a bank in October, is **not the year's
profit**. The books are open; anything in it can move before March. Nothing on the screen,
and nothing in the CSV header, said so — so the reader supplied the assumption that it was
final, which is the assumption that gets people into trouble.

The system already knows the answer. A financial year is `CLOSED`, or its `lockedUpTo`
covers the period, or it does not, so every statement now carries one of three standings in
the title block, in a banner and in the file header:

| | |
|---|---|
| **Final** | the year is closed; these figures cannot change without a reversal that shows |
| **Locked** | the lock covers this whole period, but later ones are still open |
| **Draft — books are open** | 🔴 every figure can still change |

🔴 A lock that stops *inside* the period is a draft, not a lock. Locking to 30 September and
printing a statement to 31 March leaves half the period open, and the half that is locked is
no comfort at all.

## 2. 🔴 A position at a date that has not happened

The first balance sheet this produced was headed **"As at 31 Mar 2027"** and prepared on
3 October 2026. `period.to` is the financial year *end*, which for an open year is months
away. The figures were defensible — nothing is posted in the future — and the date was not:
a balance sheet is not a document with a date on it, it *is* a date.

Clamping it to today changed the numbers, which was the surprise worth having. A payroll run
is dated the 28th, so **the current month's salaries are posted days ahead of today** and the
on-screen reports, which run to the year end, include them.

So the statements stop at the preparation date, and they say what they stopped short of:

> *1 entry is dated after that and excluded here — a payroll run is dated the 28th, so the
> current month's salaries are normally among them. The on-screen reports run to the year end
> and include them.*

A pack whose figures differ from the screen with no explanation is the one nobody can defend
in a meeting. All three statements use the same cut-off, so they tie to each other.

## 3. What the documents carry

One template serves the P&L, the balance sheet and the trial balance, because they are the
same object — ledger figures under headings with a check at the bottom. What differs is which
figures and what the check tests.

- 🔴 **"This is not a Schedule III statement"**, on every one of them. A document that looks
  like accounts and is not will eventually be filed as though it were.
- 🔴 The balance sheet **explains the derived profit line on the page**: income and expense
  accounts hold the year's result until a closing entry sweeps them into retained earnings,
  so until then the difference between the two sides *is* the profit. It is the question
  everybody asks, and answering it in an email does not scale.
- **A comparative column** — the prior financial year, shown only when one exists with
  something in it. A column of zeroes reads as a company that earned nothing last year rather
  than one that was not trading.

## 4. The journal, and one account's ledger

The file an auditor asks for first.

- 🔴 **Not paginated.** The screen pages for reading; a journal missing its last page is not
  a journal. Over 50,000 lines it **refuses** rather than truncating — a journal that stops
  in the middle of August with no indication is worse than none, because it balances.
- 🔴 **Ordered `date, entryNo, id`,** and the third is load-bearing. `JournalLine` has no
  ordering column, so the two sides of an entry come back in whatever order Postgres chooses:
  the same period exported twice could interleave differently, and an auditor diffs those
  files. The same tiebreaker went into `accountLedger`, where the running balance is computed
  line by line and was therefore not reproducible either.
- The ledger export **opens with the opening balance as a row**. Without it the running
  balance starts from a figure that is nowhere in the file.

## 5. 🔴 A value in a title escapes the escaping

docs/36 established that every user-entered cell goes through `csvCell`, which defuses
formula injection. The first ledger export built its title as
`` `Ledger — ${account.code} ${account.name}` `` — and an account name is user-entered. The
interpolated string became one cell beginning `#`, so the guard never looked at it.

It was harmless by accident: `#` is not a formula lead. The rule it broke is not harmless, so
the account now goes into cells of its own.

## 6. What rendering found

Beyond §2, three things visible only on paper:

- An **empty "Operating expenses" section** printed with a heading and a total of 0.00. That
  reads as a company that had none, rather than one that has posted none. Empty sections are
  dropped.
- A net margin of **−211%** announced in a **green** reassurance box. The box now takes its
  tone from the result and says *"A loss of ₹4,30,000 — 107.5% of total income"*.
- The standing note printed **twice on the same page**, once in the banner and again as the
  last note.

## 7. Still open

- **Comparatives only on the P&L.** The balance sheet should carry the prior year's closing
  column too, which is a second `balanceSheet` call and a wider table.
- **Nothing emails a pack.** Three documents, downloaded one at a time; the CA wants all of
  them with the trial balance, in one file.
- **No Schedule III presentation.** Named on the documents as a limitation rather than
  implemented — it is the CA's format and wants the CA.
- **The journal export is bounded, not streamed.** 50,000 lines is years away at this volume;
  past it the answer is a quarter at a time rather than a bigger buffer.
- **Cash flow and ageing have no PDF**, only CSV. Both are working documents rather than
  statements, which is why they were left.
- Carried forward: attachments on the expense screens, service-item CRUD, the mobile tail,
  chases that nobody sends, note amendments (table 9C), refund vouchers, invoice-level GST
  reconciliation.
