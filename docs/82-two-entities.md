# 82 · Two entities, one login — SPEC

**Status: agreed, not built.** Like `docs/81`, this records decisions and findings before any
code, so the build does not re-derive them.

**Entity A** — ADPEDIA FILMS PRIVATE LIMITED. GST-registered, Kerala (32), QRMP quarterly,
exports under LUT. The system as it stands.

**Entity B** — a proprietorship: freelance work paid into a personal account, no GST
registration, clients deducting TDS.

🔴 They are **different legal persons.** Different PAN, different returns, income taxed in
different hands — A's profit is the company's, B's is the proprietor's. Nothing is
consolidated, ever. One login, two company records, a switcher.

---

## 1. 🔴 Step 0 — the leak sweep, before a second company exists

Nothing else in this spec starts before this, and the reason is specific.

`src/server/repositories/scoped.ts` says of itself:

> *"This is the single enforcement point. Services take a `Scope`, not a raw Prisma client, so
> forgetting the companyId filter is not something a caller can do by accident."*

**Nothing imports it.** `new Scope` appears once, inside its own file. Its four tests —
`tests/scope.test.ts`, titled *multi-company isolation* — pass, and the application has never
used the class. Meanwhile **58 service files** hand-write `companyId: ctx.companyId`.

Isolation is therefore real but conventional: it holds because 58 files each remembered.

🔴 **And with one company, forgetting is undetectable.** Every row belongs to Adpedia Films,
so a query missing the filter returns exactly the right answer. All 614 integration tests run
against a single company, so they cannot catch it either. The day entity B exists, every such
omission returns B's rows inside A's reports — and nothing fails. Not a test, not the trial
balance, not the audit log. Two taxpayers bleeding into each other's books, silently.

So, first:

1. **A sweep test** asserting every company-scoped query carries the filter — the same shape
   as `tests/project-dimension.integration.test.ts`'s source sweep, which found five sites
   where two were expected. Scope it to the posting/query itself, not a window of lines; that
   mistake is documented there.
2. **A two-company fixture** in the integration suite, so cross-company leakage fails a test
   rather than surfacing in a report.

`SCOPED_MODELS` lists 29 models. The schema now has **65** — `attachment`, `debitNote`,
`gstFiling`, `advanceTaxPayment` and the rest are absent, which is part of why the
hand-written filters won in the first place.

**Decision taken:** do *not* block entity B on a 58-file refactor to adopt `Scope`. The sweep
test is cheap and immediate; adopting `Scope` is its own module, if ever.

## 2. Company creation and onboarding

There is no `prisma.company.create` anywhere in `src/`. The only Company row in existence came
from the seed, and `seedAll` hardcodes Adpedia's legal name, PAN, GSTIN, CIN and address.

A company needs, at birth:

| | |
|---|---|
| Chart of accounts | `seedAccounts(prisma, companyId)` is already parameterised and reusable — but see §4, the chart differs by constitution |
| A financial year | and `currentFinancialYear()`, never "the newest OPEN one" — `docs/49 §4` |
| Document series | 🔴 `docs/65 §6`: without a series, `allocateNumber` refuses, pointing at a Settings screen that does not exist |
| Expense categories | A's nine are A's; B needs its own |
| Opening balances | `docs/74`, if B has history before the system |

OWNER only. And a company is never deleted — nothing financial here ever is.

## 3. The switcher

`companyId` is a JWT claim, so switching means **re-signing the token** after re-verifying
membership against the database. Never from a request body: that is non-negotiable #6.

🔴 **Fix `user.companies[0]` first** ([`auth/service.ts:40`](../src/server/auth/service.ts)).
The membership lookup has no `orderBy` — `docs/80 §5`'s defect class exactly. With one
membership it is harmless; with two, which entity you land in on login is whatever Postgres
returns first, and that changes as rows are written. Needs a deterministic rule —
`User.lastCompanyId`, falling back to the only membership, and asking when there is genuinely
no answer.

Also:
- A switch is an **audited event**. It changes which books you are writing to.
- A **refresh must not silently restore a stale `companyId`** — the refresh path re-issues an
  access token, and it must re-read the intended company rather than the one in the old claim.
- 🔴 **The UI must make the current entity impossible to mistake.** The two sets of screens are
  otherwise identical. Not a quiet dropdown: the entity's name in the header, and a visual
  difference strong enough to notice mid-task. An invoice raised in the wrong entity is
  numbered from that entity's series, posted to its ledger and frozen on send — `docs/41`,
  `docs/59`. There is no undo, only a cancellation that keeps the number.

## 4. A chart of accounts per constitution

Today's equity section is Private-Limited-shaped: `3000 Share Capital`, `3100 Retained
Earnings`, `3200 Current Year Profit`. A proprietorship has no share capital. It needs
**Proprietor's Capital** and **Drawings**.

🔴 **Drawings is an equity contra and must never touch the P&L.** This is what lets B record
every rupee — rent, groceries, medical, household — as money taken out, keeping the money
trail complete without moving taxable profit by a paisa. Household costs posted as *expense*
would understate B's profit, and that is the only line that matters here: a complete record is
not the same as a deductible one.

Business costs genuinely incurred for B's work (client travel, software, a defensible share of
internet) are expenses, subject to s.37(1)'s "wholly and exclusively". Everything else is
drawings.

And several personal outgoings are deductible in the **personal ITR, not in B's books**: rent
against the HRA component already present in A's payroll (s.10(13A) — `prisma/seed/payroll.ts`
sets HRA at 20% of gross), medical insurance under s.80D, 80C items. B records them as
drawings and claims nothing.

## 5. Bill of supply — the document B actually issues

🔴 **`DocType` has no `BILL_OF_SUPPLY`**, and `AttachmentKind` has no equivalent either. An
unregistered person must not issue a *tax invoice*: no GSTIN, no tax shown, different heading
(rule 49). Billing at 0% on the existing template would produce a document headed **Tax
Invoice** with a GSTIN field — wrong on its face.

Needs: the enum value, its own series, its own template, its own archive kind.

🔴 `docs/65 §6`: adding an enum value and inserting rows that reference it must be **two
migration files** — Prisma runs each file in one transaction, and Postgres will not use a new
enum value in the transaction that added it.

**And the GST screens must be gated.** `gstRegistrationType` is read nowhere in `src/` — a
field nothing consumes, which is `docs/67 §2`'s class. Ungated, B would be offered GSTR-1,
QRMP periods, GST filing, the LUT register and e-invoice readiness, all meaningless for an
unregistered entity. The gate is a test, not a convention.

## 6. What the two share, and what they never do

**Shared, correctly:** the statutory rate tables — `GstRate`, `TdsSectionRate`,
`ProfessionTaxSlab` carry no `companyId` because they are law, not company data. And the
login.

**Never shared:** accounts, financial years, document series, customers, vendors, projects,
journals, attachments (storage keys are company-prefixed), reports, audit scope.

A client billed by both entities exists as two customer rows. That is correct and is not
duplication to be cleaned up — they are customers of two different suppliers.

## 7. What this must never do

- **No consolidated report of any kind.** A and B are different taxpayers; there is no figure
  that is legitimately the sum of both.
- **No shared customer or vendor master.**
- **No tax invoice from an unregistered entity**, and no GSTIN on its documents.
- **No drawings in the P&L.**
- 🔴 **No mechanism for recording a receipt in one entity's cash but not in its books.** Where a
  project genuinely spans both, it is two scopes, two agreements, two invoices and two sets of
  books, each declared in its own return. This spec provides no other path, and the codebase
  will not support one: financial rows cannot be hard-deleted — a trigger refuses — every
  change is audited, and issued documents are frozen.

## 8. Open, and for the CA rather than for code

- **B's constitution** — proprietorship or individual. Decides which PAN, which ITR, and
  whether `Constitution.PROPRIETORSHIP` is the right value.
- **The ₹20 lakh threshold.** The client's position is that B stays unregistered above it.
  Registration is mandatory above ₹20 lakh of *taxable* supplies, so this holds only if B's
  supplies are exempt or non-taxable. The spec does not encode an exemption nobody has
  confirmed: if the supplies are taxable and the threshold is crossed, registration is required
  and the bill-of-supply path in §5 stops being correct. To be confirmed before B bills
  anything near it.
- **Whether A's HRA exemption is being claimed** — §4. It is already in the payroll structure.

## 9. Build order

| | |
|---|---|
| **0** | Leak sweep + two-company fixture. Nothing else starts first |
| 1 | Company creation, per-constitution chart, onboarding |
| 2 | Switcher, the `companies[0]` ordering fix, `lastCompanyId`, audited switch, unmistakable UI |
| 3 | Bill of supply — enum, series, template, archive kind |
| 4 | Gate the GST screens on registration type |
| 5 | Drawings, and B's own expense categories |

Each ships with its guard: close the gap, then write the test that fails without the fix.
