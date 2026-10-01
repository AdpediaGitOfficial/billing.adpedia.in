# Adpedia Finance ERP — Brainstorm #2
## Bank Reconciliation · TDS · Mobile-First UX · Branded PDF Invoices

> Companion to the master module blueprint. This document goes deep on four things:
> **(A)** bank statement reconciliation against invoices, **(B)** TDS in both directions,
> **(C)** what "very mobile friendly" actually means for an accounting app,
> **(D)** Adpedia branding + PDF invoice generation.
>
> ⚠️ **Tax constants disclaimer:** every rate, threshold and due date below is an
> *illustrative default*. Indian TDS/GST rules change most Februarys. The architectural
> rule that matters: **never hard-code a rate.** Everything lives in an effective-dated
> config table and is confirmed with Adpedia's CA before go-live.

---

# PART A — Bank Statement Reconciliation

## A1. Why this is the hardest module (and the highest value)

For Adpedia, most client payments will arrive as:

```
NEFT-HDFC000123-NUVE PROPERTIES PVT L-N123456789012  ₹7,20,000 Cr
```

...against an invoice of ₹9,44,000. Nothing matches. Why?
- Client deducted **TDS ₹80,000** u/s 194J
- Client paid **part** of the invoice
- Client clubbed **two invoices** into one transfer
- Bank charged **₹1,180 forex/NEFT** on the way in

A naive "match amount = amount" reconciler will match ~30% of your lines.
A good one matches 85–90% and *learns*. That is the whole game.

## A2. Pipeline architecture

```text
  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
  │  INGEST     │ → │  NORMALISE   │ → │  MATCH ENGINE │ → │  POST & LOCK │
  └─────────────┘   └──────────────┘   └───────────────┘   └──────────────┘
   CSV / XLS /       canonical txn      rules + scoring     journal entries
   PDF / API         + dedupe hash      + human review      + BRS + period lock
```

### Stage 1 — Ingest

| Source | Priority | Notes |
|---|---|---|
| CSV / XLSX upload | **Phase 1** | Every Indian bank exports this. Ship first. |
| PDF statement | Phase 2 | Table extraction; messy, needs review screen |
| Bank API / corporate connect | Phase 3 | ICICI/HDFC corporate APIs, per-entity onboarding |
| Account Aggregator (Sahamati) | Phase 4 | Needs FIU registration — real compliance project |

**Bank profiles, not one parser.** Each bank gets a saved mapping template:

```yaml
bank_profile:
  name: HDFC Current Account
  date_format: DD/MM/YY
  header_row: 21               # HDFC exports 20 junk rows first
  columns:
    date: "Date"
    narration: "Narration"
    ref: "Chq./Ref.No."
    value_date: "Value Dt"
    debit: "Withdrawal Amt."
    credit: "Deposit Amt."
    balance: "Closing Balance"
  amount_style: separate_dr_cr   # vs single_signed_column
  encoding: utf-8-sig
```

First upload of a new bank → a **column-mapping wizard**; save it, never ask again.

**Dedupe hash** (critical — people re-upload overlapping date ranges constantly):
`sha256(bank_account_id | value_date | amount | dr_cr | normalise(narration) | ref_no)`
Duplicate hash → skip silently, report "142 rows imported, 38 duplicates ignored".

### Stage 2 — Normalise

```sql
bank_transactions (
  id, bank_account_id, import_batch_id,
  txn_date, value_date,
  amount NUMERIC(18,2), direction ENUM('debit','credit'),
  raw_narration TEXT,
  ref_no, utr, cheque_no,
  running_balance NUMERIC(18,2),
  dedupe_hash UNIQUE,
  status ENUM('unmatched','suggested','part_matched','matched','ignored','excluded'),
  matched_confidence NUMERIC(5,2),
  counterparty_guess_id,        -- learned party
  created_at
)
```

**Narration enrichment** — regex extract before matching:
- UTR: `\b[A-Z]{4}[A-Z0-9]{6,}\b`, `N\d{12}`, `UTR[: ]?(\w+)`
- Mode: NEFT / RTGS / IMPS / UPI / ACH / CHQ / CASH / INT / CHG
- Party fragment: strip mode prefix, bank IFSC, trailing ref → `NUVE PROPERTIES PVT L`

## A3. The matching engine — tiered, scored, explainable

Run tiers in order; stop at first confident hit. Every suggestion carries a
**score (0–100)** and a **human-readable reason**. Never auto-post below threshold.

### Tier 0 — Identity (score 100, auto-post)
Bank UTR == UTR recorded on a payment advice / payment link callback / previously
confirmed receipt. Zero ambiguity.

### Tier 1 — Exact invoice match (score 95)
`credit amount == invoice outstanding` AND party resolved AND txn_date within
invoice_date → invoice_date + 90d.

### Tier 2 — **TDS-aware match (score 92)** ← the feature that pays for itself
```
if (credit_amount + tds_at(section, invoice_taxable_value)) ≈ invoice_outstanding
   within ±₹2 rounding
→ propose: "Receipt with TDS @10% u/s 194J deducted by client"
→ auto-draft: Dr Bank 8,64,000 | Dr TDS Receivable 80,000 | Cr Debtors 9,44,000
```
Test every section flagged on the invoice (and 194J/194C as fallbacks). This
single rule will resolve the majority of otherwise-unmatched Indian B2B receipts.

### Tier 3 — Bank-charge / FX tolerance (score 88)
`|credit − invoice| ≤ max(₹250, 0.5%)` → propose match + auto-post the difference
to **Bank Charges** or **Forex Gain/Loss** (relevant for Emirates NBD / USD receipts).

### Tier 4 — Split & combine (score 70–85)
- **One receipt → many invoices**: subset-sum over that client's open invoices
  (cap at ~12 candidates, oldest-first bias). "₹5,00,000 = INV-041 ₹2,36,000 + INV-047 ₹2,64,000"
- **Many receipts → one invoice**: part-payment; leaves invoice `partially_paid`
- **Receipt > all open invoices**: propose **Advance from Customer** (and flag GST
  on advances if applicable)

### Tier 5 — Fuzzy party, amount unknown (score 40–65)
Trigram / Levenshtein on narration fragment vs `customer.name` + `customer.aliases[]`.
Surfaces as "Probably NUVÉ Properties — no matching invoice. Create invoice? Book as advance?"

### Tier 6 — Non-invoice classification (rules, not guesses)
Recurring narrations get a **standing rule** table:

| Narration contains | Direction | Auto-classify |
|---|---|---|
| `SALARY` / `NEFT-ADPEDIA-PAYROLL` | Dr | Payroll disbursement → match to payroll run |
| `GST PMT` / `CBDT` / `TDS` | Dr | GST / TDS challan → match to challan record |
| `AWS` / `DIGITALOCEAN` / `GOOGLE CLOUD` | Dr | Cloud expense (+ RCM check for import of service) |
| `BANK CHARGES` / `NEFT CHG` / `AMB` | Dr | Bank charges (+ input GST on charges) |
| transfer to own account | both | **Contra** — auto-pair the mirror leg, never double-count |
| `RETURN` / `REVERSAL` / cheque bounce | both | Reverse original receipt + book bounce charges |

**Learning loop:** every manual match writes a rule candidate
`(narration_signature → party/account)`. After 2 confirmations it auto-applies at
score 85. This is what turns a 60%-match system into a 90%-match system by month 3.

## A4. Reconciliation workspace

**Desktop:** two columns — bank lines left, candidates right, drag-to-match, keyboard
`↓ / Enter` to accept, `S` to split, `I` to ignore. Accounts staff will do 200 lines a day; keyboard-first matters.

**Mobile:** card stack, one txn at a time.

```text
┌────────────────────────────────┐
│ 12 Oct · HDFC ····4471         │
│                                │
│   ₹7,20,000  CREDIT            │
│   NEFT-NUVE PROPERTIES PVT L   │
│                                │
│ ┌────────────────────────────┐ │
│ │ 92%  INV-2026-041          │ │
│ │ NUVÉ Website · ₹9,44,000   │ │
│ │ + TDS ₹80,000 u/s 194J     │ │
│ │ = exact match              │ │
│ └────────────────────────────┘ │
│                                │
│  [ Split ]  [ Skip ]  [ ✓ Match ] │
│   ← swipe left / right →       │
└────────────────────────────────┘
        18 of 47 · ₹2.1L to go
```

Progress bar + "₹ remaining unreconciled" is the motivator. Bulk-accept all ≥90% in one tap.

## A5. Outputs

1. **Journal entries** — nothing is "matched" without a balanced posting.
2. **BRS (Bank Reconciliation Statement)** — the one auditors ask for:
   ```
   Balance as per books                     ₹ 14,82,340
   Add:  cheques issued not presented       ₹  2,10,000
   Less: deposits not yet credited          ₹    85,000
   Add/Less: bank charges not in books      ₹     1,180
   ─────────────────────────────────────────────────────
   Balance as per bank statement            ₹ 16,08,520   ✓ matches
   ```
3. **Period lock** — once a month is reconciled and signed off, block back-dated
   edits (allow reversal entries only). Non-negotiable for audit integrity.

## A6. Nasty edge cases to design for on day one

- Two clients pay the **same amount on the same day** → never auto-post, force choice
- Client pays **₹9,44,000 but invoice is ₹9,44,000 across two projects** → allocation split by project (feeds project P&L!)
- **Advance received before invoice** → GST on advance (services), adjust on invoice
- **Cheque bounce** → reverse receipt, re-open invoice, book bounce charges, notify
- **Statement re-download with corrected narration** → dedupe hash changes; need
  fuzzy dedupe fallback on (date, amount, balance)
- **Opening balance migration** — first-ever reconciliation needs a cutoff date and
  an unreconciled-items carry-forward
- **Multi-currency** (Emirates NBD): statement in AED/USD, books in INR → store both
  `txn_currency_amount` and `base_amount` + `fx_rate` + `fx_rate_source`

---

# PART B — TDS

TDS runs in **two independent directions**. Most billing apps do neither properly;
doing both is a genuine differentiator for an IT services company.

```text
        ┌──────────────────────────────────────────┐
        │  TDS RECEIVABLE  (asset)                 │
        │  Clients deduct from what they pay us    │
        │  → reconcile against Form 26AS / AIS     │
        │  → claim in Adpedia's own ITR            │
        └──────────────────────────────────────────┘
                            ▲
                       ADPEDIA
                            ▼
        ┌──────────────────────────────────────────┐
        │  TDS PAYABLE  (liability)                │
        │  We deduct from vendors, freelancers,    │
        │  subcontractors, salaries, rent          │
        │  → challan by 7th → 26Q/24Q → Form 16A   │
        └──────────────────────────────────────────┘
```

## B1. Direction 1 — TDS **receivable** (clients deduct from us)

### On the invoice
Invoice-level flags: `tds_applicable`, `tds_section` (194J / 194C / 194H),
`tds_rate`, `tds_base` (**taxable value, excluding GST** — CBDT Circular 23/2017,
where GST is shown separately on the invoice; verify with CA).

The invoice PDF then carries:
```
Taxable value          ₹ 8,00,000
CGST 9%                ₹   72,000
SGST 9%                ₹   72,000
Invoice total          ₹ 9,44,000
Less: TDS @10% u/s 194J (on taxable value)   ₹ 80,000
──────────────────────────────────────────────────────
Net amount payable     ₹ 8,64,000
```
This one line dramatically reduces payment disputes and short-payment queries.

### In receivables
- AR ageing must show **expected net (₹8,64,000)** as collectible and
  **₹80,000 as "TDS expected"** — otherwise every paid invoice looks perpetually overdue
  and your collections follow-up cries wolf.
- Bucket: `Outstanding = Invoice − Received − TDS expected − Credit notes`

### Entries
```
Invoice:   Dr Debtors 9,44,000 | Cr Revenue 8,00,000 | Cr Output CGST 72,000 | Cr Output SGST 72,000
Receipt:   Dr Bank 8,64,000 | Dr TDS Receivable (194J, FY26-27, Q3) 80,000 | Cr Debtors 9,44,000
```
`TDS Receivable` is tagged by **FY + quarter + deductor (client) + TAN + section** —
because it must later reconcile to 26AS line-by-line.

### 26AS / AIS reconciliation (quarterly ritual)
Import the 26AS text/CSV export → match on `(deductor TAN, section, quarter, amount)`.

```text
TDS RECONCILIATION — Q3 FY 2026-27

Booked in our system          ₹ 4,12,000   (14 entries)
Appearing in Form 26AS        ₹ 3,52,000   (11 entries)
──────────────────────────────────────────────────────
⚠ Missing in 26AS             ₹   60,000   (3 clients)
   • NUVÉ Properties  ₹40,000 — deducted, not yet filed
   • Client X         ₹15,000 — TAN mismatch
   • Client Y         ₹ 5,000 — booked in wrong quarter
⚠ In 26AS, not in books       ₹    8,400   (1 entry) → unrecorded income?
```
Each gap becomes a **follow-up task** ("request Form 16A from NUVÉ"). Unclaimed TDS
is straight cash lost at ITR time — for a company Adpedia's size this is easily ₹2–5L/year.

### Reports
TDS receivable ageing by client · by section · by quarter · unreconciled 26AS ·
clients who deduct but never file · Form 16A received/pending register.

## B2. Direction 2 — TDS **payable** (we deduct from vendors)

### Rate engine — effective-dated, never hard-coded
```sql
tds_sections (
  code,                  -- '194J'
  description,           -- 'Professional / technical services'
  effective_from, effective_to,
  rate_company NUMERIC(5,2),
  rate_individual_huf NUMERIC(5,2),
  rate_no_pan NUMERIC(5,2),          -- typically 20%
  threshold_single NUMERIC(18,2),
  threshold_annual NUMERIC(18,2),
  base ENUM('taxable_value','gross'),
  applies_to_resident BOOLEAN
)
```
Illustrative seed (**confirm with CA — FY2025-26 revised several thresholds**):

| Section | Applies to | Rate | Threshold |
|---|---|---|---|
| 194J | Professional fees, consultants | 10% | annual, per vendor |
| 194J(ba) | Fees for **technical** services | 2% | annual |
| 194C | Contract / subcontract work | 1% ind-HUF, 2% company | single + annual |
| 194H | Commission, brokerage | 5% (verify) | annual |
| 194-I(b) | Office rent | 10% | annual |
| 194-I(a) | Plant & machinery rent | 2% | annual |
| 192 | Salary | slab-based avg rate | — |
| 195 | Payments to non-residents | DTAA-dependent | — (needs Form 15CA/CB) |
| No PAN (206AA) | any | 20% | — |

For Adpedia the hot ones are **194J** (freelance devs, designers, CA/legal) and
**194C** (subcontracted agencies). Note the 194J professional-vs-technical distinction
is a real audit point — make it a per-vendor default, overridable per bill.

### Threshold tracking (the bit everyone gets wrong)
Track **cumulative FY payments per vendor per section**. When the annual threshold is
crossed mid-year, TDS is due **retrospectively on the whole amount**, not just the excess.

```text
Vendor: Rahul Design Studio · Section 194J · FY 2026-27
  Bill 1  ₹18,000  → below threshold, no TDS
  Bill 2  ₹22,000  → ⚠ cumulative ₹40,000 crosses threshold
                     System proposes: deduct on FULL ₹40,000 now
                     Catch-up TDS ₹4,000 on this bill
```
Surface this as a blocking prompt on bill entry, not a report discovered in March.

### Lower / nil deduction certificate — Section 197
Vendors will send these. Store: certificate no., section, **rate**, valid from/to,
**amount cap**. Apply the certificate rate automatically until the cap is exhausted,
then revert to normal rate and warn.

### Lifecycle
```text
Vendor bill ₹2,36,000 (₹2,00,000 + GST ₹36,000)
   │
   ├─ Dr Project Cost 2,00,000
   ├─ Dr Input CGST 18,000 / Input SGST 18,000
   └─ Cr Vendor (AP) 2,36,000
            │
            ├─ TDS 194J @10% on ₹2,00,000 (excl GST)
            │     Dr Vendor (AP) 20,000 | Cr TDS Payable–194J 20,000
            │
            └─ Payment: Dr Vendor (AP) 2,16,000 | Cr Bank 2,16,000
                        ↑ the bank line that Part A must reconcile
   
Monthly: challan ITNS 281 by 7th of next month (March → 30 April)
         Dr TDS Payable–194J 20,000 | Cr Bank 20,000
         Capture CIN / BSR code / challan serial / deposit date
         Link challan ↔ every deduction it covers (mandatory for 26Q)
```

### Compliance calendar (build it as an actual calendar screen)
| Task | Typical due date |
|---|---|
| TDS deposit (Apr–Feb) | 7th of following month |
| TDS deposit (March) | 30 April |
| 26Q / 24Q return Q1 | 31 July |
| Q2 | 31 October |
| Q3 | 31 January |
| Q4 | 31 May |
| Form 16A issue | within 15 days of return due date |
| Form 16 (salary) | 15 June |

Interest & penalty calculator:
- **1%/month** — deductible but not deducted
- **1.5%/month** — deducted but not deposited
- **₹200/day (s.234E)** — late return, capped at the TDS amount
Show "if you file on 12th instead of 7th: interest ₹X" — makes it visceral.

### Return filing — build an **export layer**, not a filer
Do **not** hard-code FVU/RPU file generation; NSDL formats change and break silently.
Instead generate a validated **deductee-wise CSV/Excel** matching the current 26Q
schema (deductee PAN, name, section, date of payment, amount paid, TDS, challan CIN,
BSR, deposit date) that the CA imports into RPU. Add a **pre-flight validator**:
missing PAN, invalid PAN format, PAN-name mismatch, unlinked challan, challan amount
≠ sum of deductions. Catching those before filing is 90% of the value.

### Also worth flagging (design hooks, not phase 1)
- **GST TDS u/s 51** — 2% if Adpedia bills government departments/PSUs; you receive it,
  claim it in the GST cash ledger. Separate from income-tax TDS. Model as its own field.
- **194Q / 206C(1H)** — goods purchases > ₹50L; unlikely for services, but keep the hook.
- **206AB higher rate for non-filers** — *omitted from FY 2025-26; verify.* Keep the
  rule-engine slot so a future reinstatement is config, not code.
- **Section 195 + Form 15CA/CB** — becomes relevant the moment Adpedia pays a foreign
  subcontractor or a US SaaS vendor. Flag any non-resident vendor at bill entry.

## B3. Where TDS shows up in the UI
- **Invoice form**: TDS section dropdown + auto-computed net payable
- **Vendor bill form**: auto-suggested section from vendor master, threshold warning banner
- **Vendor master**: default section, PAN, PAN-verified flag, 197 certificate, resident/non-resident
- **Dashboard tile**: "TDS payable ₹1,24,000 · deposit by 7 Nov · 8 days"
- **Dashboard tile**: "TDS receivable ₹4,12,000 · ₹60,000 missing from 26AS"
- **Reports**: TDS deducted register, challan register, deductee summary, 26AS recon

---

# PART C — Mobile-First, Properly

"Mobile friendly" for an ERP does **not** mean a responsive data table. A 14-column
invoice grid squeezed onto a 390px screen is unusable no matter how well it scales.
Mobile needs **different information architecture**, not different CSS.

## C1. Decide what mobile is *for*

| Role | On mobile they do | They will never do on mobile |
|---|---|---|
| **Owner (Shine)** | Check numbers, approve, chase, share invoice on WhatsApp | Chart of accounts, journal entries |
| **Accounts staff** | Record receipt, upload bill photo, reconcile a few lines | Bulk data entry, GST filing prep |
| **Project manager** | Check project margin, log vendor cost | Payroll |
| **Employee** | Submit expense with a photo, view payslip | Anything else |

So: **three mobile "apps" inside one PWA**, selected by role. Owner mode is a read +
approve surface. Don't ship a mobile chart-of-accounts screen nobody opens.

## C2. Navigation

Bottom tab bar, 5 slots max, thumb-reachable:

```text
┌─────────────────────────────────────┐
│                                     │
│          (content)                  │
│                                     │
│                                     │
│                        ╭───╮        │
│                        │ + │  FAB   │
│                        ╰───╯        │
├─────┬─────┬─────┬─────┬─────────────┤
│ 🏠  │ 📄  │ 💰  │ ✅  │ ☰          │
│Home │Invo │Money│Appr │More         │
└─────┴─────┴─────┴─────┴─────────────┘
```
- `+` FAB = context-aware quick create (invoice / receipt / expense / bill)
- "More" holds Payroll, Accounting, GST, Reports, Settings — the desktop-heavy stuff
- Badge count on Approvals; that's what pulls the owner back in daily

## C3. Cards, not tables

**Rule: on <768px, a table becomes a list of cards.** Every row card shows
1 primary amount, 2 supporting facts, 1 status chip. Detail lives one tap away.

```text
┌──────────────────────────────────┐
│ INV-2026-041          🟡 PARTIAL │
│ NUVÉ Properties                  │
│ NUVÉ Website                     │
│                                  │
│ ₹9,44,000       Paid ₹7,20,000   │
│ Due 15 Oct · 12 days overdue     │
│                                  │
│ ⋯ swipe → Remind · PDF · Receipt │
└──────────────────────────────────┘
```
Swipe-right = primary positive action (Record receipt / Approve).
Swipe-left = secondary (Send reminder / Reject). Always with an Undo snackbar —
never a confirm dialog for reversible things, always a dialog for irreversible ones.

## C4. Indian number formatting — everywhere, non-negotiable

- Digit grouping: `₹9,44,000` not `₹944,000`
- Compact display in tiles: `₹25.4L`, `₹1.2Cr`, `₹8.2L`
- Tap a compact number → expands to full value (don't make people guess)
- Never truncate a number in a PDF or a ledger — compact form is dashboard-only

## C5. Forms on mobile

Long forms kill mobile adoption. Use **progressive sheets**:

```text
New Invoice  →  Step 1: Client + Project   (2 fields, recent clients as chips)
                Step 2: Line items          (add item sheet, SAC autofilled)
                Step 3: GST + TDS           (auto-computed, mostly read-only)
                Step 4: Review + Send       (live PDF preview, share targets)
```
- Numeric keypad (`inputmode="decimal"`) for every amount field
- Client/project pickers are **search-first**, with "recent 5" pre-populated
- GST/CGST/SGST/IGST **never** typed — derived from place of supply vs Adpedia's state
- Autosave draft on every field blur; never lose an invoice to a phone call interrupting

## C6. Capabilities that make it feel native

| Capability | Why it matters here |
|---|---|
| **Installable PWA** | Home-screen icon, no app store, instant updates |
| **Camera → expense** | Snap the restaurant bill, OCR amount/date/GSTIN, attach to project |
| **Offline queue** | Expense + receipt capture works in a basement / on a flight; syncs later |
| **Push notifications** | "₹2.36L payment received", "GST due in 3 days", "Approval pending" |
| **Biometric unlock** | WebAuthn — financial data behind Face ID after 5 min idle |
| **Web Share API** | Share invoice PDF straight to **WhatsApp** — this is how Indian B2B collections actually happen |
| **Add to Calendar** | GST/TDS due dates into the owner's calendar |

## C7. Performance budget (enforce it)

- Dashboard: **one** aggregated endpoint, pre-computed nightly + incremental, not 14 queries
- First contentful paint < 1.5s on 4G; interactive < 3s
- Skeleton screens, never spinners, for lists
- Virtualised lists beyond 50 rows
- Route-level code splitting: an employee submitting an expense never downloads the GL module
- Ship server-computed totals; the phone should never sum 4,000 ledger rows

## C8. Owner home screen (the screen that decides whether this app gets used)

```text
┌────────────────────────────────────┐
│ Good evening, Shine     🔔 3       │
│ FY 2026-27 · Oct                   │
├────────────────────────────────────┤
│  REVENUE THIS MONTH                │
│  ₹25.4L            ▲ 18.4%         │
│  ▁▂▄▃▅▇█  last 7 months            │
├─────────────────┬──────────────────┤
│ RECEIVABLE      │ PAYABLE          │
│ ₹8.2L           │ ₹4.5L            │
│ 7 overdue  ⚠    │ due this week    │
├─────────────────┴──────────────────┤
│ PROJECT PROFIT (MTD)               │
│ ₹10.3L · 41.2% margin              │
├────────────────────────────────────┤
│ NEEDS YOU                          │
│ ⚠ 7 invoices overdue    ₹3.1L  →   │
│ ⚠ 47 bank lines to match       →   │
│ ⚠ TDS challan due 7 Nov ₹1.24L →   │
│ ⚠ GST filing · GSTR-1 in 4 days →  │
│ ✓ 3 vendor bills to approve    →   │
└────────────────────────────────────┘
```
Every line is a tap into a drill-down. "Needs you" is the retention mechanic —
an accounting app people open daily is one that tells them what's on fire.

---

# PART D — Adpedia Branding & PDF Invoices

## D1. Company profile = data, not hard-coded assets

Multi-entity from day one (you already have an Emirates NBD account in the list —
that smells like a second entity or at least a second currency).

```sql
companies (
  id, legal_name, trade_name,            -- "Adpedia ..." / "Adpedia"
  logo_light_url, logo_dark_url,          -- SVG preferred, PNG @3x fallback
  signature_image_url, stamp_image_url,
  brand_primary_hex, brand_accent_hex, brand_font,
  gstin, pan, tan, cin, msme_udyam_no,
  registered_address_json, branch_addresses_json,
  state_code,                             -- drives CGST/SGST vs IGST
  phone, email, website,
  invoice_footer_text, default_terms, default_notes,
  currency_default, fy_start_month        -- 4 = April
)

company_bank_accounts (
  id, company_id, label, account_name, account_no, ifsc, swift,
  bank_name, branch, currency, upi_id, show_on_invoice, is_default
)

invoice_series (
  id, company_id, doc_type,               -- invoice / proforma / credit_note / quotation
  prefix,                                 -- 'ADP'
  pattern,                                -- 'ADP/{FY}/{SEQ:4}'  → ADP/26-27/0041
  fy, next_seq, reset_on_fy_change BOOLEAN
)
```

**Invoice numbering rule (GST law):** unique, consecutive, ≤16 chars, alphanumerics
`/` and `-` only, resets per financial year. Gaps must be explainable — so **never
delete** an invoice; cancel it and keep the number. Enforce sequence allocation
inside the DB transaction that creates the invoice (a Postgres sequence or a
`SELECT ... FOR UPDATE` on the series row), never in app code — concurrent invoice
creation producing duplicate numbers is a GST notice.

## D2. Mandatory tax-invoice content (build a validator, not a checklist in a doc)

Supplier name/address/GSTIN · invoice no + date · recipient name/address/GSTIN ·
**place of supply** · HSN/**SAC** per line · description, qty, unit, rate, taxable value ·
discount · tax rate + amount split CGST/SGST/IGST/Cess · **total in words** ·
reverse-charge indicator · signature or digital signature.

Block "Send" if any mandatory field is missing. A soft warning nobody reads is worth nothing.

**Tax logic to get right:**
- Adpedia state == client state → **CGST + SGST**; different state → **IGST**
- Client without GSTIN, B2C, value > ₹2.5L, inter-state → must carry recipient address
- **Export of services** → IGST-free under LUT; PDF must print:
  *"Supply meant for export of services under LUT without payment of IGST. LUT ARN: …"*
  Plus currency, FIRC/BRC tracking, and the export invoice series.
- **SEZ client** → zero-rated, separate declaration
- **RCM** on import of services (AWS, Figma, etc.) → self-invoice generation module

## D3. PDF generation — recommended architecture

```text
Invoice saved
   ↓
Enqueue render job (BullMQ)
   ↓
PDF worker: React template → HTML+CSS → Playwright(Chromium) → A4 PDF
   ↓
Upload to S3-compatible storage
   ↓
Store {url, sha256, template_version, rendered_at} on the invoice
   ↓
Serve via short-lived signed URL
```

**Why headless Chromium over a PDF DSL:**
- The template is ordinary React + CSS — your team already writes this
- What you preview in-browser is *byte-identical* to the PDF
- Real support for Devanagari/₹ glyphs, web fonts, CSS Grid, page-break control
- `@page { size: A4; margin: 12mm }`, `thead { display: table-header-group }` gives
  repeating headers on multi-page invoices for free

**Immutability rule:** once an invoice is *Sent*, the PDF is frozen. Store the rendered
bytes, not just the template reference — if you change the template in March, the
October invoice you email a client must still look exactly as they received it.
Version templates; stamp `template_version` on every document.

**Also generate:** proforma, quotation, credit/debit note, receipt voucher, delivery
note (rare for services), customer ledger statement, vendor ledger, payment advice,
Form 16A cover letter, payslip. All the same pipeline, different template.

## D4. Invoice layout (mobile-viewable, print-correct)

```text
┌──────────────────────────────────────────────────────┐
│ [ADPEDIA LOGO]                         TAX INVOICE   │
│ Adpedia <Legal Name>              Invoice ADP/26-27/0041 │
│ <Registered address>              Date    01 Oct 2026│
│ GSTIN 32XXXXXXXXXXXZX             Due     15 Oct 2026│
│ PAN XXXXX0000X · CIN …            PO      NUVE/PO/88 │
├──────────────────────────────────────────────────────┤
│ BILL TO                     │ PLACE OF SUPPLY        │
│ NUVÉ Properties Pvt Ltd     │ Kerala (32)            │
│ <address>                   │ Project: NUVÉ Website  │
│ GSTIN 32YYYYYYYYYYYZY       │                        │
├──┬───────────────────┬──────┬─────┬───────┬──────────┤
│# │ Description       │ SAC  │ Qty │ Rate  │  Amount  │
├──┼───────────────────┼──────┼─────┼───────┼──────────┤
│1 │ Website design &  │998314│  1  │8,00,000│ 8,00,000│
│  │ development —     │      │     │       │          │
│  │ Phase 1           │      │     │       │          │
├──┴───────────────────┴──────┴─────┴───────┼──────────┤
│                          Taxable value    │ 8,00,000 │
│                          CGST  9%         │   72,000 │
│                          SGST  9%         │   72,000 │
│                          ─────────────────┼──────────│
│                          TOTAL            │ 9,44,000 │
│                          Less TDS 10% 194J│  (80,000)│
│                          NET PAYABLE      │ 8,64,000 │
├───────────────────────────────────────────┴──────────┤
│ Rupees Eight Lakh Sixty Four Thousand Only           │
├───────────────────────┬──────────────────────────────┤
│ BANK DETAILS          │   ▓▓▓▓▓▓▓                    │
│ A/c Name  …           │   ▓ UPI ▓   Scan to pay      │
│ A/c No    …           │   ▓▓▓▓▓▓▓                    │
│ IFSC      …           │                              │
│ Bank/Branch …         │        [signature image]     │
│                       │        Authorised Signatory  │
├──────────────────────────────────────────────────────┤
│ Terms: Payment within 15 days. 18% p.a. on overdue.  │
│ <footer / declaration / e-invoice IRN + QR if appl.> │
└──────────────────────────────────────────────────────┘
```

Details worth building:
- **Amount in words, Indian system** — "Eight Lakh Sixty Four Thousand", not "Eight Hundred Sixty Four Thousand"
- **UPI QR** on the PDF — measurably faster collections from smaller clients
- **Payment link** (Razorpay/Cashfree) button; webhook auto-creates the receipt *and*
  feeds Part A's Tier-0 exact match with a known UTR
- **HSN/SAC summary block** if you have multiple SACs (GSTR-1 needs it anyway)
- **"Original for Recipient / Duplicate for Supplier"** copy labels
- **e-Invoice readiness**: if turnover crosses the IRP threshold, invoices must be
  registered with the IRP *before* issue and carry **IRN + signed QR**. Design the
  invoice record with `irn`, `ack_no`, `ack_date`, `signed_qr` columns now and an
  IRP adapter interface — retrofitting this later is painful.

## D5. Delivery & tracking

- Email with the PDF attached + a hosted "view invoice" link → status `Sent` → `Viewed`
- **WhatsApp share** from mobile (Web Share API with the PDF file)
- Auto-reminders: T-3 days, due date, T+7, T+15, T+30 — templated, owner-approvable,
  pausable per client (don't nag the client you're mid-negotiation with)
- Every send logged: who, when, to which address, which PDF hash

---

# PART E — How it all wires into one ledger

The point of all four parts is that they meet in the general ledger:

```text
 INVOICE (Part D)  ──────┐
   Dr Debtors            │
   Cr Revenue            │
   Cr Output GST         ├──►  GENERAL LEDGER  ◄──┐
                         │      (double entry,    │
 BANK LINE (Part A) ─────┤       FY-scoped,       │
   Dr Bank               │       period-locked)   │
   Dr TDS Receivable ────┤                        │
   Cr Debtors            │                        │
                         │                        │
 VENDOR BILL ────────────┤                        │
   Dr Project Cost ──────┼──► PROJECT P&L         │
   Dr Input GST          │                        │
   Cr Vendor AP          │                        │
   Dr Vendor AP          │                        │
   Cr TDS Payable (B2) ──┘                        │
                                                  │
 PAYROLL ──► Salary Expense + allocation % ───────┘
             ──► Project staff cost ──► Project P&L
```

**Invariants to enforce in code and test:**
1. Every financial event produces a balanced journal entry (Σ Dr = Σ Cr) — enforce
   with a DB constraint/trigger, not application discipline
2. No document is ever hard-deleted; cancel + reverse
3. Every posting carries `fy_id`, `company_id`, `posted_at`, `created_by`, `source_doc_ref`
4. Reconciled/filed periods are locked; edits require an explicit reversal entry
5. Full audit trail — append-only `audit_log` on every financial table
6. `NUMERIC(18,2)` everywhere; **never** floats for money

---

# PART F — Suggested build order

| Phase | Ships | Why here |
|---|---|---|
| **0** | Company profile, branding, FY setup, chart of accounts, users/roles | Everything depends on it |
| **1** | Clients, projects, invoices, **branded PDF**, payments, AR ageing | First real value: you can bill |
| **2** | GST on sales, vendors, vendor bills, input GST, AP | Closes the tax loop |
| **3** | **TDS payable** (deduct, threshold, challan, 26Q export) | Compliance deadline-driven |
| **4** | **TDS receivable** + 26AS reconciliation | Recovers real money |
| **5** | **Bank import + reconciliation engine** (CSV first) | Needs 1–4 to have things to match against |
| **6** | Payroll + staff allocation → project P&L | Makes project margins true |
| **7** | Expenses, recurring, mobile capture, offline | Broadest user base, lowest risk |
| **8** | Full reports: P&L, balance sheet, cash flow, project/client P&L | Depends on clean ledger |
| **9** | e-Invoice IRP, payment gateway, bank API feed, multi-entity/UAE | Scale-ups |

Reconciliation lands at Phase 5 deliberately: a matching engine with nothing to match
against is a demo, not a feature. Build the documents first, then the matcher.

---

# PART G — Open questions before writing code

**Branding / invoice content (needed to build the PDF template):**
1. Adpedia's exact **legal entity name**, registered address, state
2. **GSTIN, PAN, TAN, CIN**, MSME/Udyam number (if registered)
3. **Logo files** — SVG preferred, plus a light/dark variant; brand hex colours; preferred font
4. **Authorised signatory** name + signature image (and company stamp, if used)
5. **Bank account details** to print — which account, and UPI ID for the QR
6. Default **payment terms**, late-fee clause, invoice footer/declaration text
7. Preferred **invoice number format** — e.g. `ADP/26-27/0041`?

**Tax / compliance:**
8. Is Adpedia **registered under GST** — regular or composition? Any **LUT** for export of services?
9. Annual turnover — does **e-invoicing (IRN/QR)** apply now or soon?
10. Do you **deduct TDS** on vendors/freelancers today, or does the CA handle it offline?
11. Which SAC codes do you bill under? (998314 IT design & development is the usual one)

**Structural:**
12. **Emirates NBD** in your bank list — is there a **UAE entity**? That means multi-entity,
    AED/USD, 5% VAT and 9% corporate tax — a materially different build. Worth deciding now.
13. Which banks for statement import, and can you share one **sample statement export** per bank?
14. Roughly how many invoices/vendor bills/bank lines per month? (Sizes the reconciliation UX)
15. Migrating from Zoho Books / Tally / spreadsheets? Opening balances + a cutoff date will be needed.

---

# PART H — Axis Bank parser profile (from the real statement)

Derived from `Account_Statement_Report_30-09-2026_1204hrs.PDF` — 200 transactions,
01/02/2026 to 30/09/2026, Axis Bank current account, Chalakudy branch.

## H1. Use the CSV/Excel export, not the PDF

The PDF's text layer interleaves columns badly — particulars wrap across lines and land
between the date and amount fields. It's parseable, but fragile in exactly the way that
silently mis-books a transaction six months from now.

**Axis internet banking exports the same statement as `.xls`/`.csv`.** Use that. Keep PDF
parsing as a fallback with a mandatory review screen, never as the primary path.

## H2. Column profile

```yaml
bank_profile:
  name: Axis Bank — Current Account (CA Business Select)
  account_no: '921020015185413'
  ifsc: UTIB0002174
  date_format: DD/MM/YYYY
  columns:
    serial:      'S.NO'
    txn_date:    'Transaction Date'
    value_date:  'Value Date'
    narration:   'Particulars'
    cheque_no:   'Cheque Number'
    amount:      'Amount(INR)'
    direction:   'Debit/Credit'     # literal 'DR' / 'CR'
    balance:     'Balance(INR)'
    branch:      'Branch Name(SOL)'
  amount_style: single_column_with_dr_cr_flag
  has_opening_closing: true          # 'Opening Balance: INR 47,306.25'
```

Reconcile the parsed rows against the printed **opening and closing balance** on import —
if `opening ± Σ(credits − debits) ≠ closing`, reject the whole batch. Cheap, catches
every parsing error before it reaches the ledger.

## H3. Narration grammar — observed frequencies

| Pattern | Count | Shape | Extract |
|---|---:|---|---|
| `IMPS/P2A/…` | 84 | `IMPS/P2A/<12-digit RRN>/<PARTY>/<acct or bank>/<remark>` | RRN, party, **remark** |
| `INB/IFT/…` | 27 | `INB/IFT/<name>/TPARTY TRANSFER` | party (intra-Axis transfer) |
| `INB/NEFT/…` | 20 | `INB/NEFT/<AXODH…>/<name>/<bank>//////` | **UTR**, party |
| `NEFT/<BANK>…` | 21 | `NEFT/<HDFCH…|KKBKH…|FBBT…|EBIL…>/<PARTY>/<bank>/<remark>` | **UTR**, party, remark |
| `MOB/TPFT/…` | 15 | `MOB/TPFT/<name>/<account no>` | party |
| `Monthly Service Chrgs` | 16 | fixed | → Bank Charges |
| `GST @18% on Monthly Service Chrgs` | 13 | fixed | → Input GST on bank charges |
| `Int.pd` | 1 | fixed | → Interest Income |
| `CLG` | 1 | cheque clearing | → match to cheque |

**UTR regex:** `\b(?:AXODH|HDFCH|KKBKH|FBBT|EBIL|SBIN|ICIC|UTIB)[A-Z0-9]{8,}\b`
**IMPS RRN:** `IMPS/P2A/(\d{12})/`

## H4. The remark field is the highest-value signal

Your IMPS narrations already carry a purpose written by whoever made the payment:

```
IMPS/P2A/605108713778/SHINELAL/X111100/HDFCBANKLTD/Gstfeesf
IMPS/P2A/605417950533/SHINELAL/X111100/HDFCBANKLTD/Officeex
NEFT/HDFCH00786034370/KAYLA MAYOTECH LLP/HDFC BANK/0001Resource Payment
IMPS/P2A/605210103936/DEEPAK DAMODARAN/X084328/STATEBANKOFINDIA/Bed
```

Parse the trailing segment and feed it into the rule table. `Resource Payment`,
`Officeex`, `Gstfeesf` are already a informal chart of accounts — formalise it rather
than discarding it. Seed the classifier with these and it will be useful on day one.

## H5. Seed rules for this account

| Match | Direction | Post to |
|---|---|---|
| `Monthly Service Chrgs` | DR | Bank Charges |
| `GST @18% on Monthly Service Chrgs` | DR | Input GST — bank charges |
| `Int.pd` | CR | Interest Income |
| party ∈ {`CLICK AR BUSINESS PRIVATE LI`, `KAYLA MAYOTECH LLP`, `EXALTURE`} | CR | **Customer receipt** → run the invoice matcher (Tiers 1–4) |
| party ∈ {`SHINELAL`, `DEEPAK DAMODARAN`, `PRAVEEN C D`, `NIKHIL MA`, `AKASH RAVEENDRAN`} | DR | ⚠️ **needs a decision — see below** |
| `INB/IFT/<own name>` both legs same day | both | Contra — auto-pair, exclude from P&L |

## H6. ⚠️ The classification decision this statement forces

152 of the 200 lines are outward payments, and a large share go repeatedly to the same
five or six individuals. Before any of this can post correctly, each recurring payee
needs a **standing classification**, because the treatment differs completely:

| If they are… | Account | TDS | Appears in |
|---|---|---|---|
| **Employees** | Salary expense | s.192, slab-based, Form 24Q | Payroll, project staff cost |
| **Freelancers / consultants** | Professional fees | **s.194J @10%**, Form 26Q | Vendor ledger, project cost |
| **Subcontractors** | Contract payments | **s.194C @1–2%**, Form 26Q | Vendor ledger, project cost |
| **Directors drawing funds** | Director's remuneration *or* loan account | 192 or 194J | Balance sheet — **not** P&L |

Right now these are indistinguishable from the narration alone. This is the single
decision that most affects whether your P&L and project margins come out right — and
you hold a TAN (`CHNA09808A`), so the TDS obligation on these is already live.

## H7. Scale check

~25 transactions a month. That's a **weekly five-minute reconciliation**, not a data-entry
job. Implications for the build:

- The swipe-card mobile UX in Part C is sufficient; skip the desktop power-user grid in v1
- Subset-sum matching over open invoices is trivially fast at this volume
- 47 receipts in 8 months means the invoice matcher has a small, high-value workload —
  worth doing carefully rather than at scale
- The real volume is **outward payments and expenses**, so expense capture, vendor
  classification and TDS deserve the engineering attention, not bulk receipt matching
