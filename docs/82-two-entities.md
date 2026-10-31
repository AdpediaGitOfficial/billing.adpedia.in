# 82 · Two entities, one login

**Status: built — steps 0 to 5, 30–31 Oct 2026.** This began as a spec, written before any
code so the build would not re-derive its decisions, and the decisions are kept here as they
were taken. What each step actually found is in §1, §5a and §5c; §8 is what remains, and it is
for the CA rather than for code.

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

→ **§5c, built.**

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
unregistered entity. The gate is a test, not a convention. → **§5a, built.**

## 5a. 🔴 Step 4 — the gate, and what hiding it did not cover

Step 3 took the GST items out of an unregistered entity's rail and put an explanation on three
screens. Neither is a refusal, and `nav.ts` says so of itself: *"the server also refuses
whatever the UI hides."* It did not.

🔴 **Nothing here failed. Every one of these paths WORKED for B**, and that is the whole
problem: what comes out is a plausible return for a taxpayer that does not exist.

| Reached by | What it did for B |
|---|---|
| `/api/tax/gst/export?return=gstr1` — a URL, not a screen | built a GSTR-1 out of its bills of supply and served the CSV |
| the filing form's action | recorded a GSTR-1 as filed against a return it must not file |
| the payment form's action | posted a challan for tax it never collected |
| the set-off form's action | debited electronic ledgers it does not hold |
| the LUT form's action | accepted a Letter of Undertaking — the one `§5` singles out |
| `/tax/portal`'s import | reconciled its books against a cash ledger of zero, and called them agreed |

So the gate is now in the services, where the refusal belongs: `tax/gst-registration.ts`, with
`requireGstRegistered` left as the *explanation* on the screens rather than the enforcement.

🔴 **And the condition was being asked of the wrong field.** The calendar read
`if (company.gstin)`. An unregistered entity has none, so its GST items happened not to appear
— correct by accident. A **composition** taxpayer has one and files CMP-08 and GSTR-4, so it
was told to file a GSTR-1 on the 11th and a GSTR-3B it never files, both stuck overdue for
ever because nothing could ever clear them. `filesGstr1And3b()` is that question asked once.

### 🔴 The invoice B could not issue at all

The find that was not a screen. `resolveLutForInvoice` keyed off the tax **mode**, and an
unregistered supplier billing abroad resolves to `EXPORT` like anybody else — so **send
refused**, demanding Form RFD-11, which requires the registration B does not have. B had no
way to bill a foreign client, and the error named the one remedy it cannot perform.

A LUT belongs to zero-rating a **taxable** supply. Where no tax is charged there is no rate to
zero: `carriesTax(docType)` is the condition, and a bill of supply needs no LUT, shows no
"needs a LUT" pill on the form and no missing-LUT banner on the document.

### What is deliberately NOT gated

- **`/tax/portal` is not `gstOnly`.** OLTAS challan status is the one statement there that an
  unregistered entity still uses, so the GST half is gated section by section and the TDS half
  stays. Hiding the page would have taken away something it needs.
- **`unrecordGstFiling` and `cancelGstSetOff`** each require an existing row of B's, and there
  is now no way to create one. A guard there would be code no test could reach — `docs/80 §7`'s
  class, which is what this module spent its time closing rather than adding to.
- **The dashboard's Output GST tile** reads ₹0 for B, which is true. It is noise, not a false
  obligation.

🔴 **Found while gating, and fixed afterwards in §5d:** the calendar told B to *"file the
company income tax return"* on **31 October**, three months after the 31 July its proprietor
actually owes under s.139(1)(c).

## 5c. Step 5 — drawings, and the categories B can act on

### The register

`OwnerMovement` — a `DRAWING` out or `CAPITAL` in, each with a date, an amount, the account it
moved through and a note. A drawing also carries a **purpose**, and that field is the only
reason the record is worth keeping: rent against HRA (s.10(13A)), insurance under s.80D, 80C
investments are all claimed in the owner's **personal** return, and none of them can be sorted
out from "₹85,000 taken out" with no purpose against it. The purpose is required on a drawing
and refused on capital — money coming in needs no story.

🔴 **The posting is `Dr 3300 Drawings · Cr bank`, and nothing else.** `profitAndLoss` reads
INCOME and EXPENSE, so an equity contra cannot reach it however much goes through. That is the
whole mechanism: rent, groceries and medical bills are recorded in full, the bank statement
reconciles to the rupee, and the profit the proprietor declares does not move. The same
spending put through an expense category would have understated that profit by its entire
value, with s.37(1)'s "wholly and exclusively" as the provision cited when it was noticed.

**There is no cancel, and there is no delete** — the table has the same `BEFORE DELETE`
trigger every other financial table has. A drawing entered wrongly is corrected by a CAPITAL
movement for the same amount, which is what happened if the money went back and an honest
correction if it did not.

🔴 **`ownerFunds` is asked of the balance sheet, not computed again.** Summing the EQUITY
accounts reads too low for eleven months of the year, because this year's profit does not reach
`3200 Current Year Profit` until the year-end close — `statements.ts` derives it instead. Two
computations of one figure would have let the drawings screen disagree with the statement it
gets checked against, and then neither number is worth anything. It can legitimately go
**negative**, which is information rather than an error: a proprietor may take out more than
the business earned, and that means its creditors are funding it.

### 🔴 A company is refused, and the refusal is the tax point

`hasDrawings` is false for a company, and both the rail and the service say so. What looks like
a director's drawing is one of three transactions, and they are not three labels for the same
transfer:

| | |
|---|---|
| Remuneration | salary in the director's hands, TDS under s.192 |
| Dividend | a distribution of profit that has already been taxed |
| Loan | GL 2500 Director's Current Account — s.185 limits it, and it has to come back |

### B's expense categories: the same nine, different defaults

The nine categories were A's, and seeded unchanged they told B two things that were false.
Neither failed, which is why it matters:

| | |
|---|---|
| 🔴 `itcDefault: 'FULL'` | ₹1,800 of GST on a ₹10,000 bill debited to `1210 Input CGST` and `1220 Input SGST` as an **asset** — one that can never be utilised, because s.16(1) gives credit to a registered person. The cost was understated by the tax and the balance sheet carried a receivable from nobody |
| 🔴 `tdsSection: '194J'` | B withholding tax it has no TAN to deposit, a TDS Payable it cannot clear, a 26Q it cannot file — and the deductee losing the credit |

So the defaults now follow what the entity can actually do. Not the constitution alone: ITC and
RCM are **registration** facts, while who must deduct TDS is a fact about the payer —
s.194C and s.194J exclude an individual below the s.44AB limits, and a company, firm or LLP
deducts from the first rupee whatever its size. `deductsTdsByDefault` is that distinction, and
🔴 it is not permanent: the year after the **preceding** year crosses ₹1 crore, B becomes
liable to deduct. That is the same limit §8 watches with the ₹80 lakh alert.

**And the rule lives in the service, not only in the data.** `createExpense` reads the
registration itself, so a category edited by hand cannot put tax into an input-credit asset.
The blocking is also not a s.17(5) clause: none of those clauses apply, so the reason is
supplied — *"the entity is not registered for GST — s.16(1) gives credit to a registered person
only"* — rather than demanded from a list that has no right answer in it. Before this, an
expense with tax on the line was a dead end for B: it refused to save until a clause was picked.

🔴 **Two of the blocked-credit reasons said "Adpedia" on every entity's screen.** `docs/82 §1`'s
class, found here: generic now.

### Open, and worth asking the CA before B buys anything abroad

🔴 **An import of services makes registration compulsory.** If B subscribes to Adobe, Google or
any overseas supplier, that is an import of service: the recipient pays the tax under reverse
charge, and s.24(iii) makes a person liable to pay tax under reverse charge liable to register
**with no threshold at all**. The ₹20 lakh limit in §8 does not protect it. `rcmPossible` is
false on B's categories because an unregistered entity has no RCM to raise — but the answer to
"what if it buys software from abroad" is *register*, not *ignore it*, and that is a question
for the CA rather than a default in a table.

## 5d. The ITR date, which was a company's date on everybody's calendar

Found while gating step 4, fixed after step 5.

🔴 The calendar said *"File the company income tax return"* on **31 October** for every entity,
and `deadlines.ts` had it hardcoded with a comment that said so: *"Company ITR where a tax
audit applies"*. It was written when this system had one taxpayer and that taxpayer was a
company. s.139(1) has **two** dates:

| | |
|---|---|
| clause (a) | **31 October** — a company, anyone whose accounts must be audited, and a partner of a firm whose accounts must be audited |
| clause (c) | **31 July** — everybody else |

So B was being shown a deadline three months after its own. Filing late costs s.234A interest
on the tax, a s.234F fee, and the loss carry-forward under s.80 — and nothing in the system
would ever have noticed, because the date looked authoritative.

### 🔴 Which way the uncertainty is resolved is the whole decision

Whether an audit applies is a s.44AB question, and §8 leaves part of it open. The two mistakes
are not symmetrical:

- Showing 31 October to somebody who owes 31 July makes them **late**.
- Showing 31 July to somebody who has until October makes them **early**, which costs nothing.

So `itrPosition` only ever concludes "audited" where no unknown fact could change it: a company
(clause (a) by being a company, whatever its turnover), or turnover past **₹10 crore**, which
is above every limb of s.44AB(a). Between ₹1 crore and ₹10 crore the answer depends on whether
cash receipts *and* cash payments were each 5% or less — a fact about every transaction in the
year, including ones these books never see. 🔴 **It is deliberately not estimated from the cash
ledger.** An estimate that pushed the date to October would be a guess in the one direction
that costs money. The earlier date stands and the item says what would move it.

Turnover is `revenue.total` from the P&L — the 40xx accounts — and not `totalIncome`:
s.44AB(a) says "sales, turnover or gross receipts in **business**", so interest on a deposit
and a forex gain are income and are not turnover. Counting them would push an entity over a
limit it has not reached.

### What the calendar says now

| | | |
|---|---|---|
| Adpedia Films | ITR-6, 31 October | s.139(1)(a), plus **Form 3CA/3CB-3CD on 30 September** — a new item, because the report is due a month before the return it holds up and it is the half that waits on somebody else's diary |
| B | ITR-3, **31 July**, *the proprietor's own return* | the income is taxed in the proprietor's hands, so it is their return and not the entity's |
| a firm or LLP | ITR-5, 31 July | |

🔴 **The audit-report item appears only where the audit is certain.** An item nobody owes is how
a calendar gets ignored (`docs/43 §1`), so it is not shown "just in case".

The annual-filings screen in Settings reads the same resolved date through `rocYears`, rather
than calling `itrDue` itself — it was the second place printing 31 October, and two
computations of one deadline is how a screen comes to disagree with the reminder chasing it.

**Still open, and for the CA:** whether B's accounts need auditing at all in a year — the cash
test, and the s.44AD(4) case in §8 where declaring under 8% of turnover as income requires
books and an audit at *any* turnover. Both move this date to 31 October when they bite.

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

- ✅ **B's constitution — settled 30 Oct 2026: a PROPRIETORSHIP on the proprietor's own
  personal PAN.** Confirmed against the PAN card itself: the 4th character is `P`, which the
  income tax department issues to an **individual**, so `createCompany` accepts it for
  `PROPRIETORSHIP` and would refuse it for a partnership or an LLP. "Managing Partner" on the
  document is a signing title, not a legal form — and on a proprietorship's document
  **"Proprietor" is the accurate designation**, since a partner implies partners.

  What follows from it: §4 stands as written. The income is taxed in the proprietor's own
  hands, not in the entity's, so drawings is how personal spending is recorded and the
  personal deductions — HRA against the salary from A, 80D, 80C — belong in the proprietor's
  ITR rather than in B's books. An LLP or a firm would have been a separate taxpayer filing
  ITR-5, and none of that reasoning would have held.

  🔴 **The PAN is deliberately NOT written into this repository.** Adpedia Films' identifiers
  are here because they are the company's, on a repo with no remote; a living person's PAN is
  a different thing to commit, and this repo was nearly pushed to a PUBLIC GitHub repository
  on 5 Oct. It belongs in the database, entered through Settings → Companies, where it is
  data rather than source. The test fixtures keep a fictional PAN for the same reason.
- **The ₹20 lakh threshold.** The client's position is that B stays unregistered above it.
  Registration is mandatory above ₹20 lakh of *taxable* supplies, so this holds only if B's
  supplies are exempt or non-taxable. The spec does not encode an exemption nobody has
  confirmed: if the supplies are taxable and the threshold is crossed, registration is required
  and the bill-of-supply path in §5 stops being correct. To be confirmed before B bills
  anything near it.
- 🔴 **The turnover limits B is actually watching.** Asked for an ₹80 lakh threshold; clarified
  as the **tax audit** limit, which is not the GST one. Three separate figures, and they are
  not interchangeable:

  | | |
  |---|---|
  | GST registration | **₹20 lakh** of taxable supplies (services, normal state). Statutory, not a setting |
  | Tax audit — business | **₹1 crore** turnover, or ₹10 crore where cash receipts *and* cash payments are each ≤5% — s.44AB(a) |
  | Tax audit — profession | **₹50 lakh** gross receipts — s.44AB(b) |

  ✅ **Settled 30 Oct 2026: B's work counts as a BUSINESS**, so the audit limit is
  **₹1 crore** of turnover under s.44AB(a), not the ₹50 lakh that applies to a profession.
  The classification follows the nature of the work rather than a preference: s.44AA(1)
  notifies legal, medical, engineering, architectural, accountancy, technical consultancy,
  interior decoration and film-artist work as professions, and B's sits outside that list.

  **₹80 lakh stands as the early-warning level** — 80% of the real limit, which is the notice
  it was chosen to give.

  🔴 **The ceiling is not the only trigger, and the second row is the one that bites a
  practice with real costs:**

  | | |
  |---|---|
  | s.44AB(a) | turnover above **₹1 crore** — or **₹10 crore** where cash receipts *and* cash payments are each 5% or less |
  | 🔴 s.44AD(4)–(5) with s.44AB(e) | declaring **less than 8%** of turnover as income (6% on receipts taken through banking channels) while total income exceeds the basic exemption — books and an audit become required at **any** turnover, not only near the ceiling. Opting out after opting in also locks the entity out of s.44AD for five years |
  | s.44AD | presumptive **8%**, or **6%** on banked receipts, available up to ₹2 crore (₹3 crore where cash is 5% or less) |

  🔴 **Worth establishing before any of it matters:** B's receipts land in a bank account, so
  if its cash receipts and payments are each 5% or less — which a bank-only practice satisfies
  — the audit threshold is **₹10 crore** rather than ₹1 crore, and B is nowhere near it. What
  would still bite at a far lower turnover is the second row: a year in which declared income
  falls below 8% of turnover. That is the figure the monitor has to watch, and it is not a
  turnover figure at all.

- **Whether A's HRA exemption is being claimed** — §4. It is already in the payroll structure.

## 9. Build order

| | |
|---|---|
| **0** | Leak sweep + two-company fixture. Nothing else starts first |
| 1 | Company creation, per-constitution chart, onboarding |
| 2 | Switcher, the `companies[0]` ordering fix, `lastCompanyId`, audited switch, unmistakable UI |
| 3 | Bill of supply — enum, series, template, archive kind |
| ✅ 4 | Gate the GST screens on registration type — §5a. Done 31 Oct 2026 |
| ✅ 5 | Drawings, and B's own expense categories — §5c. Done 31 Oct 2026 |

**All six steps are built.** What is left is in §8, and all of it is for the CA rather than
for code.

Each ships with its guard: close the gap, then write the test that fails without the fix.
