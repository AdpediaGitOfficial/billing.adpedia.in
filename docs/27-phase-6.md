# 27 · Phase 6 — TDS Receivable & Form 26AS

**Status: done.** Typecheck and lint clean, **227 tests** (111 unit + 116 integration).

Phase 5 covered what Adpedia pays the government. This covers what the government already
holds on Adpedia's behalf — and whether it can actually be claimed.

---

## 1. The stake

TDS a client deducts is **cash the government already has**. It is claimable in the ITR
only if it appears in **Form 26AS**. A credit that never reaches 26AS is **lost, not
deferred** — the client kept the money, told nobody, and there is nothing to set off.

That one sentence is why this phase exists, and it is written on the screen, in the
reconciliation output, and in the dashboard alert.

## 2. Form 26AS parsing — tolerant, and loud about what it skips

26AS arrives in several shapes: the portal's caret-delimited text export, a CSV, or
whatever a CA pastes into a spreadsheet. Rather than demand one layout, the parser reads
each line **positionally**:

- a **TAN** (`[A-Z]{4}\d{5}[A-Z]`) anchors the row
- a **section code** identifies the nature of payment
- the two largest money columns are the amount paid and the tax deducted
- any readable date sets the quarter — in the **financial** year, so August is Q2

🔴 **Nothing is silently dropped.** A line that cannot be read is returned in `skipped`
with its line number and the reason, because a skipped row is a missing tax credit:

```
line 2: No deductor TAN on the line
line 3: No section code recognised
```

It handles `₹1,00,300.00` with symbols and Indian grouping, and ignores headers and
comment lines without reporting them as failures.

## 3. Reconciliation — three tiers, loosest last

Matching is on **deductor TAN**, because that is what 26AS is keyed by — not the client's
name, which the department spells differently from your books.

| Tier | Match on |
|---|---|
| 1 | TAN + section + quarter + amount (±₹1) |
| 2 | TAN + quarter + amount — *the client filed it under another section* |
| 3 | TAN + section + amount — *the client filed it in a different quarter* |

Tiers 2 and 3 exist because clients routinely misclassify. The match is still recorded,
and the tier is reported so the variance is visible rather than hidden.

## 4. The two findings that matter

**Missing from 26AS** — booked in the ledger, absent from the department's record:

> Ask Nuvé Properties Pvt Ltd for Form 16A for Q2. Until this appears in 26AS it cannot be
> claimed in the ITR — it is lost, not deferred.

**In 26AS, not in the books** — the department has a credit with nothing behind it:

> KAYLA MAYOTECH LLP reported deducting ₹6,000.00 that is not in the books. Usually an
> invoice that was never raised, or a receipt not recorded — investigate before the ITR.

The second is the more interesting one. A deductor only files TDS against a payment they
actually made, so a row with no counterpart almost always means **revenue that was never
invoiced**. In the demo data this surfaces Kayla Mayotech — a real counterparty from the
Axis statement that has no invoice behind it.

And when a client has no TAN on record, the reconciler says so rather than reporting a
false gap:

> No TAN on record for Nuvé Properties Pvt Ltd, so nothing can be matched. Get their TAN first.

## 5. The Form 16A chase list

Grouped by client, with the quarters and the amount, and flagged when past the deadline —
Form 16A is due **within 15 days of the return due date**, which `certificateDueDate()`
already computed in phase 5:

> Nuvé Properties Pvt Ltd deducted ₹4,000.00 across Q2 but has not issued Form 16A — Q2 is
> past the 15-day deadline.

## 6. On the dashboard

The gap is surfaced as a critical alert, because it is money leaving quietly:

> ₹4,000 of TDS is missing from Form 26AS — 1 deduction a client kept but has not filed.
> A credit that never reaches 26AS cannot be claimed — it is lost, not deferred.

## 7. Schema

Two additions, both deliberate:

- **`Customer.tan`** — 26AS is keyed by deductor TAN, so the customer record has to carry one.
- **`Form26asEntry`** — imported rows are **kept**, not matched-and-discarded. A row that
  matches nothing is itself a finding, so it has to survive the reconciliation. A re-import
  replaces the year rather than doubling it.

## 8. Still open

- ⚠️ **Client TANs.** Only a customer with a TAN on record can be reconciled. Collect them
  from any Form 16A already received — the TAN is printed on it.
- ⚠️ **Aggregated 26AS rows.** Where a client files one consolidated entry covering several
  of our receipts, the three tiers will not match it. A fourth tier — subset-sum across
  unmatched receivables for the same TAN and quarter — is the natural extension, and the
  structure supports it.
- ⚠️ **No file upload**, only paste. Reading a .txt or .csv from disk is a small addition;
  the parser already takes raw text.
- 🔴 **TDS rates remain placeholders** — the fifth phase to say so, and still the one thing

> **Superseded:** the rates and slabs were filled in later — see [32-tax-rates.md](32-tax-rates.md). They are statutory as at 01 Apr 2025 and still need the CA's sign-off.
  blocking live use.
