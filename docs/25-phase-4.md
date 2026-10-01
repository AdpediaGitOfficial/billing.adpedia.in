# 25 · Phase 4 — Payroll

**Status: done.** Typecheck and lint clean, **179 tests** (90 unit + 89 integration).

Project margin is real from this phase onward. Before it, cost reaching a project came
only from vendor bills; salary — the largest line — was invisible.

---

## 1. 🔴 s.192 is not a flat rate

Every other section deducts a percentage of a payment. s.192 does not. It is **1/12 of
the estimated annual tax liability**, recomputed each month as the picture changes:

```
monthly = (estimated annual tax − deducted so far this FY) ÷ months remaining
```

The estimate comes from the **CA**. Regime election, investment declarations,
house-property loss and other income all feed it, and none of that belongs in an
accounting system guessing at the Income Tax Act. `SalaryTaxEstimate` records their
number with a source and a note, and a revision **supersedes** rather than overwrites —
the earlier figure stays, because it is what the earlier deductions were based on.

The payslip shows its working:

> ₹3,73,333.34 outstanding over 7 months

### Without an estimate, nothing is deducted — loudly

Kiran N S in the demo data has no estimate. The run shows a red alert, the payslip shows
a dash, and the warning names the consequence:

> TDS cannot be computed without the CA's estimated annual tax for this employee. Nothing
> will be deducted until it is entered — and under-deduction carries interest at 1% a month.

A silent zero would be far worse than a visible gap.

## 2. Kerala profession tax

Levied by the **local body** on half-yearly earnings, by slab, payable twice a year.
It applies **regardless of headcount** — EPF needs 20 employees and ESI needs 10, so
neither touches Adpedia; this one does.

Deducted in **September and March**, the months it falls due, rather than smeared across
twelve. The payslip names the slab it landed in:

> H1 half-year, slab above ₹125000 on ₹1428000

🔴 The nine slabs are seeded as the commonly published Kerala figures and **must be
confirmed with the CA**, exactly like the TDS rates.

## 3. 🔴 Staff allocation makes project margin real

```
Akash Raveendran   Prime 60% · Nuvé 30% · Internal 10%
                   ₹80,000 → ₹48,000 · ₹24,000 · ₹8,000
```

Two decisions hold this together:

**Allocation does not move money between accounts.** Salary stays in 5110/5120 for the
P&L; the journal lines carry `projectId` as a **dimension**. Project cost is a
`GROUP BY`, not a parallel chart of accounts (`11-data-model.md` §2.1). One set of books,
two views.

**The unallocated share stays as overhead.** Akash's 10% internal time never reaches a
project, so `SUM(staffCost)` across projects is ₹72,000 of his ₹80,000 — and that is
correct, not a rounding loss. A test pins it.

Allocations must total exactly 100%, and the error says what to do:

> Allocations must total 100% — this one comes to 90.00%. Put the remainder against
> Internal if the time is not billable.

## 4. The director is posted separately

`5110 Director's Remuneration` is its own account, distinct from `5120 Staff Salaries`.
Mixing them makes the P&L misleading and the related-party note harder to prepare.

Because Shinelal's remuneration is paid **as salary under s.192** (docs/04 §7), it carries
no GST and no deemed-dividend exposure — the two risks the other treatments would have
brought.

## 5. The monthly run

```
Dr 5110 Director's Remuneration   2,38,000     ← split by allocation
Dr 5120 Staff Salaries            1,77,000     ← split by allocation
Cr 2210 TDS Payable — 192            59,048
Cr 2310 Profession Tax Payable        5,000
Cr 2300 Salary Payable             3,50,952
```

Paying the salaries clears 2300 against the bank. **The TDS and profession tax stay as
liabilities** until their challans are paid — they are not part of the transfer, and the
screen says so.

Each run also writes `TdsDeduction` rows under section 192 with `deducteeType: EMPLOYEE`,
which is what Form 24Q will consume in phase 5.

## 6. Three bugs worth recording

**A back-relation landed on the wrong model.** My regex for `allocations StaffAllocation[]`
matched `Project` before `Employee` — both have that field — so Prisma inferred a relation
and added a `projectId` column to `SalaryTaxEstimate`. The error surfaced as
*"The column SalaryTaxEstimate.projectId does not exist"*. Model-scoped matching now.

**`prisma format` had already added the back-relation**, so fixing it by hand produced two,
and an *"Ambiguous relation"* error. Worth knowing: `prisma format` writes relations, it
does not only reformat.

**A schema edit aborted after the migration had run**, leaving the database ahead of
`schema.prisma`. `prisma migrate status` confirmed the reconciliation. Writing the SQL
migration by hand and the schema separately makes this possible — worth doing the schema
edit first and letting it fail before touching the database.

## 7. Screens

| Route | |
|---|---|
| `/payroll/employees` | structure, annual estimate, allocation; red banner for missing estimates |
| `/payroll/runs` | preview with every number's working, approve, pay; month chips for history |
| `/reports/project-pnl` | revenue, staff, vendor, margin — grouped from journal lines |

## 8. Still open

- 🔴 **Profession tax slabs are placeholders** — confirm with the CA before the first

> **Superseded:** the rates and slabs were filled in later — see [32-tax-rates.md](32-tax-rates.md). They are statutory as at 01 Apr 2025 and still need the CA's sign-off.
  September deduction.
- 🔴 **Annual tax estimates** for all four people — without them s.192 deducts nothing.
- ⚠️ **Payslip PDF** is not built. The data is complete (`Payslip.components` holds the
  breakdown and the allocation); it needs the same Playwright pipeline as the invoice,
  which is still deferred from phase 1.
- ⚠️ **Vendor bills are not yet allocated to projects** in the demo data, so project P&L
  shows ₹0 of vendor cost. The field exists and the posting rule carries it — the demo
  simply did not set it.
- **Challans and Form 24Q** arrive in phase 5. The deductions are already recorded and
  tagged by quarter.
