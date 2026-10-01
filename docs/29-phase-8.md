# 29 · Phase 8 — Financial reports

**Status: done.** Typecheck and lint clean, **286 tests** (145 unit + 141 integration).

Phases 1–7 put numbers into the ledger. This phase gets them back out in the five shapes
a company, a CA and a bank actually ask for — and makes every one of them drillable down
to the journal lines underneath.

---

## 1. One source, no second set of books

Every report here is built on **one function**, `accountBalances()` in
[`ledger.ts`](../src/server/services/reports/ledger.ts), which reads **journal lines**.
No report queries the invoice table for revenue or the bill table for cost.

That is not a style preference. A report that re-derived revenue from invoices could
disagree with the trial balance — and once two numbers disagree, neither is trustworthy
and somebody spends a day finding out which. Posting everything through `postJournal`
in phase 1 is what makes a single answer possible, and this phase is where that pays off.

`opening` is every movement strictly before the period start, which is what allows a
balance sheet at any date without running a year-end close first.

## 2. The three self-checks

Each statement proves something about itself, and says so on screen:

| Report | Checks | If it fails |
|---|---|---|
| Trial balance | Σ debits = Σ credits | the **ledger** is corrupt, not the report |
| Balance sheet | assets = liabilities + equity | an entry bypassed the double-entry service |
| Cash flow | derived movement = actual bank balance change | an entry touched cash in a way the classifier missed |

These are asserted in the integration tests, not just displayed.

## 3. 🔴 Why the balance sheet needs the P&L

A balance sheet built by summing account balances **does not balance**, and the reason
catches people out every time: income and expense accounts hold the year's profit, and
they appear on neither side of the balance sheet. Until a year-end entry sweeps them into
retained earnings, *the difference between assets and liabilities **is** the profit*.

So it is put back — computed from the same period's movement and shown as an explicit
line marked **calculated**:

```
Equity
  3200  Current year profit        [calculated]      -₹12,32,900.00
```

Nothing is written to account 3200. A mid-year balance sheet must not fabricate journal
entries, and the figure changes with every transaction entered. The test asserts both
halves: that the equity figure equals the P&L's net profit, **and** that the journal
contains zero lines on 3200.

There is also a test that the statement would *not* balance without the fold-in — so a
future refactor that drops it fails loudly here instead of shipping a wrong statement.

Prior-year profit that was never closed out is folded in separately, for the same reason.

## 4. Cash flow — direct method

The indirect method starts from profit and adjusts it. It needs a prior-period balance
sheet and cannot be checked by eye. The **direct method** here is built from what actually
moved through the bank and cash accounts, so every line can be read against the Axis
statement — and after phase 7 those are the reconciled movements, so the two agree by
construction.

Classification comes from the **contra** account, because a bank line on its own says
nothing: fixed assets → investing, share capital and director's current account →
financing, everything else → operating.

### 🔴 Attributing cash to the legs that actually funded it

A receipt posts three lines:

```
Dr  Bank              1,08,000
Dr  TDS Receivable       10,000
Cr  Accounts Receivable          1,18,000
```

Spreading the ₹1,08,000 inflow across every non-cash leg reports **₹8,437 of cash
"received against TDS Receivable"** — which never happened. The TDS leg is a *debit*, the
same side as the cash: it did not fund the inflow, it is a second non-cash application of
the same settlement.

Only legs on the **opposite** side of the cash movement are credited. The totals tie
either way, which is exactly what makes this dangerous — the error hides inside a report
that looks correct and foots perfectly.

## 5. 🔴 Ageing net of TDS

An invoice of ₹59,000 on which the client must withhold ₹5,000 is aged at **₹54,000**,
not ₹59,000.

Ageing at gross overstates the debt by exactly the tax. The client is never going to send
that ₹5,000 — they are legally required to pay it to the government instead. Chasing them
for it is chasing a payment that **cannot be made**. It is still a receivable, but from
the government, and it is collected by getting it onto Form 26AS (phase 6), not by a
reminder email. The screen says so, and reports the withheld total separately.

Payables are the mirror: what Adpedia owes a vendor is net of the TDS it withholds,
because that part is owed to the government on the 7th.

Buckets are **Not due / 1–30 / 31–60 / 61–90 / 90+**, measured from the due date, not the
invoice date.

## 6. Client P&L

The same journal lines as the project view, grouped by the customer dimension. Costs reach
a client two ways — tagged to the customer directly, or tagged to one of their projects —
and both are counted. It is not a plain `GROUP BY customerId`, because a payroll
allocation lands on the *project*, never on the customer.

## 7. Drill-through

Every account code on every statement is a link to its ledger: opening balance, each entry
with its running balance, closing balance, and a link back to the invoice or bill that
caused it. The last line's running balance **is** the closing balance — asserted in a test,
because a ledger whose running total doesn't land on the stated closing figure is worse
than no ledger at all.

The journal register shows every entry with its lines and its own debit/credit totals,
flagging any entry that does not balance.

## 8. Screens

| Route | What it is |
|---|---|
| `/reports` | index of everything below |
| `/reports/pnl` | Profit & Loss, grouped revenue / direct cost / overhead |
| `/reports/balance-sheet` | position at a date, with the profit fold-in explained |
| `/reports/cash-flow` | direct method, three activity buckets |
| `/reports/ageing` | AR and AP, bucketed, net of TDS |
| `/reports/client-pnl` | margin by client |
| `/accounting/trial-balance` | opening, movement, closing for every account |
| `/accounting/journal` | the complete entry-by-entry record |
| `/accounting/accounts` | chart of accounts with live balances |
| `/accounting/accounts/[code]` | the per-account ledger — the drill-through target |

The financial-year picker is shared, so a chosen year follows you between reports.

## 9. What this phase found

Both caught by rendering the reports against real data, not by a test:

1. **Cash flow misattributed inflows** across non-funding legs (§4). Fixed, and now
   asserted.
2. **"Total assets" rendered twice** on the balance sheet — the section component and the
   page were each emitting a total.

## 10. Still open

- **Export to Excel/PDF** for these statements — the GST and TDS screens have it, these
  do not yet.
- **Comparatives** (this year vs last) on the P&L and balance sheet.
- **Year-end closing entry** that actually sweeps P&L into retained earnings; today the
  fold-in is computed every time, which is correct but means the books are never formally
  closed.
- Schedule III presentation grouping, if the CA wants statements in statutory format.
