# 74 · Opening balances, and the carry-forward that must stay derived

**Status: done.** 992 tests (411 unit + 581 integration), typecheck and lint clean,
production build passes.

`docs/37 §8`: *"Closing does not carry forward opening balances as explicit entries; the
balance sheet reads cumulative movement instead, which is equivalent and simpler, but a CA
expecting a formal opening-balance journal in the new year will not find one."*

Half of that is now built and the other half is now a written-down refusal, because building
it would have been wrong. They are different things that share a name.

---

## 1. 🔴 The year-end carry-forward must stay derived

Every report in this system reads **cumulatively**:

```ts
// balanceSheet — closing balances at the date, opening irrelevant
const balances = await accountBalances(ctx, { from: new Date(0), to: asOf })
```

So a balance-sheet account already carries forward by itself. An opening entry posted into the
new year would be added to a balance that already includes it, and **every asset, liability and
equity figure would double**.

Silently. The entry balances, the trial balance still balances, and the only sign is that the
numbers are twice what they should be — which on a balance sheet is the kind of wrong that gets
believed, because the statement still agrees with itself.

The alternatives were:

- **Make the reports read from the financial-year start**, with the opening entry as their
  starting point. That is the textbook design, and migrating the balance sheet, the trial
  balance's opening columns, the ledger drill-down and the exports onto it is a large, risky
  change to produce a formality.
- **Post the entry and exclude `OPENING_BALANCE` from cumulative reads.** Then it is
  decorative: a line in the ledger that the ledger's own reports refuse to count, which is a
  worse lie than not having one.

So the refusal is the answer, and the service enforces it rather than leaving it to a comment —
`setOpeningBalances` on any year but the earliest fails, and says why. What a CA asking for
opening balances should be given is the **trial balance's own opening columns**, which have
computed exactly this since `docs/26`.

## 2. The real gap: the first year

There is one position this system genuinely cannot derive, and it is not the carry-forward. It
is the position on the day the company **started keeping its books here** — because the history
before that is in somebody's spreadsheet.

🔴 `OPENING_BALANCE` has been in `SourceType` since phase 1 with **nothing in the codebase able
to write it**. `docs/49`'s class, found in an enum this time: not a service with no caller, but
a value with no producer, which no survey had been looking for.

## 3. What an opening entry may contain

- 🔴 **Balance-sheet accounts only.** An opening balance on an income or expense account would
  put last year's trading into this year's profit and loss — the exact thing the year-end close
  exists to prevent. What belongs in the opening position is the *result* of that trading, in
  3100 Retained Earnings, which whoever is migrating has from their old books.
- **It must balance**, and the refusal says what the difference usually is. At the moment a
  company starts keeping books, assets equal liabilities plus equity; the gap is almost always
  retained earnings that has not been carried in. The form says so while somebody is still
  typing, which is worth more than refusing at the end.
- 🔴 **Restated, not appended.** Opening balances get revised two or three times during a
  migration. Posting again **reverses** the entry standing and posts a new one — rule 2 of
  `docs/00 §3` applies here as everywhere, and the pair shows an auditor that the figures were
  restated and when. Appending would leave the ledger holding both.

## 4. 🔴 Dated the first day, and therefore movement

The entry is dated the financial year's **start**, which means it reads as that year's first
movement rather than appearing in the trial balance's opening column.

The alternative is dating it the day before, which lands in a year that either does not exist
here or is closed — and `assertPostable` would refuse it, rightly. For a migration year the
chosen presentation is the honest one anyway: the opening entry *is* the first thing that
happened on this system.

## 5. 🔴 An empty entry is not a balanced one

The form's first version showed **"Balanced"** in green over a blank table, with the button
live, because zero equals zero. `docs/71`'s "shortfall ₹0.00" in a new place: a zero that reads
as a verdict. Nothing entered is its own state, and it says so.

## 6. Still open

- **Nothing cancels an opening entry outright** — restating it to a single zero line is refused
  (it would not balance), and reversing it by hand through the journal is the current answer.
  Arguably right: a company that has started keeping books here has an opening position,
  whatever it is.
- **No import.** The lines are typed. A trial-balance CSV from the old system is the obvious
  next step and is not here.
- `docs/37 §8`'s remaining item: GST return filing still does not advance the period lock
  automatically.
- Carried forward from `docs/00 §7`: IRN and QR on the invoice template, server-side pagination
  on the three 100-row lists, removing a user and changing a role, and the ITR/GSTR-9
  financial-year question from `docs/72 §2`.
