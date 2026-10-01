# 14 · Master Build Prompt

Paste the block below into Claude Code or Lovable to start the build. It is self-contained
on the non-negotiables, and points at the other docs for detail.

**Build one phase at a time.** Do not paste the whole thing and ask for the finished
system — phase 0 and 1 first, verified, then the rest.

---

## The prompt

````text
Build "Adpedia Finance ERP" — an internal finance system for Adpedia Films Private
Limited, an Indian software and film-production company in Kerala.

This is a DOUBLE-ENTRY ACCOUNTING SYSTEM with billing, payroll, Indian GST, Indian TDS
and bank reconciliation on top. It is not a billing app with reports bolted on.

## STACK (fixed — do not substitute)
Next.js 15 App Router + TypeScript · Tailwind + shadcn/ui · PostgreSQL 16 · Prisma
JWT access + refresh tokens (argon2id) · Redis + BullMQ · Playwright for PDF
S3-compatible storage · deploys to DigitalOcean/AWS · responsive PWA
Multi-company capable from day one.

## THE SCHEMA ALREADY EXISTS
Use prisma/schema.prisma as given. It validates. 42 models, 30 enums.
Do not redesign it. If you believe something is missing, say so before changing it.

## NON-NEGOTIABLE RULES — violating any of these is a bug

1. MONEY is Prisma Decimal @db.Decimal(18,2). Never float, never number, never parseFloat.
   Round HALF_UP to 2dp per line, THEN sum. Never sum then round.

2. EVERY financial event writes a balanced JournalEntry (Σ debit === Σ credit).
   Assert it in the journal builder AND with a deferred Postgres constraint trigger.
   Posting rules are pure functions (document, config) => Posting[] with no I/O.

3. INVOICE NUMBERS are allocated by the database inside the creating transaction, via
   SELECT ... FOR UPDATE on DocumentSeries. Never in application code. Never by a user.
   Format ADP/{FY}/{SEQ:4}. FY 2026-27 starts at 26. Concurrency test required:
   50 parallel creates must yield 50 distinct sequential numbers with no gaps.

4. NOTHING IS HARD-DELETED. Cancel + post a reversal entry. A cancelled invoice keeps
   its number — gaps in a GST series must be explainable.

5. TAX RATES ARE DATA. TdsSectionRate and GstRate are effective-dated rows. Always
   resolve with rateAsOf(code, documentDate). Never a constant, never "current".
   Historic documents must keep reproducing their original tax.

6. MULTI-COMPANY ISOLATION: every query is scoped by the companyId in the JWT, never
   by one from a request body. Enforce in the repository layer, not per-handler.

7. PERIOD LOCK: every posting path calls assertPostable(companyId, date) first.

8. AUDIT LOG on every financial table: who, when, before, after. Append-only.

## GST — THREE MODES, DERIVED NEVER TYPED
Adpedia is in Kerala, state code 32, GSTIN 32AAUCA9985H1ZX.
  customer.country !== 'IN'                  -> EXPORT  zero-rated, no GST
  customer.stateCode === '32'                -> INTRA   CGST 9% + SGST 9%
  otherwise                                  -> INTER   IGST 18%
EXPORT requires a CompanyLut row covering the invoice's financial year. If there is
none, BLOCK sending — do not warn. LUTs are annual and expire silently.

## TDS — BOTH DIRECTIONS
RECEIVABLE: customers deduct from us (194J 10% / 194C 2%). Recognised ON RECEIPT, not
on raising. AR ageing must treat the TDS portion as expected, not overdue.
PAYABLE: we deduct from vendors and staff.
  192  Shinelal (director, remuneration as salary), Akash, Deepak, Kiran   -> 24Q
  194J the 9 freelancers                                                  -> 26Q
  194C Exalture Software Lab (a company, so 2% not 1%)                    -> 26Q
  195  Afrizon Crenergy Trade Pte (Singapore) + Form 15CA/15CB            -> 27Q

THRESHOLD CROSSING IS RETROSPECTIVE. When a vendor's cumulative FY payments cross the
annual threshold on a given bill, TDS falls due on the WHOLE cumulative amount, not the
excess. This must be a BLOCKING PROMPT on the bill form, not a month-end report.
TDS base is taxable value EXCLUDING GST (CBDT Circular 23/2017).
No verified PAN -> 20% under s.206AA.

## REVERSE CHARGE
Vendors with isForeignSupplier = true (DigitalOcean, Afrizon) charge no GST. Adpedia
self-accounts IGST @18%, generates a self-invoice under s.31(3)(f), pays the RCM IN CASH
(never set off against existing ITC), and claims it back as ITC. Net cost zero.
AWS India and GoDaddy India are Indian-billed — normal ITC, no RCM.

## MOBILE
Responsive PWA. Below 768px tables become CARDS — never a horizontally scrolling grid.
Bottom tab bar, 5 slots, role-shaped. Indian digit grouping (₹9,44,000) everywhere;
₹25.4L / ₹1.2Cr in dashboard tiles only, never in a ledger or PDF.
Offline queue for expense capture. Web Share API to WhatsApp for invoice PDFs.

## PDF
templates/invoice/tax-invoice.html already exists and is the reference implementation.
Render with Playwright headless Chromium in a BullMQ worker, never in a request.
Once an invoice is SENT the PDF bytes are FROZEN — store them, not just a template
reference. Changing the template must not alter an invoice already with a client.

## BUILD THIS PHASE ONLY: <phase>
Read docs/10 through docs/13 for detail. Ask before deviating from the schema or the
rules above. Write the tests named in docs/10 §7 as you go, not afterwards.
````

---

## Phase prompts

Substitute for `<phase>`:

| Phase | Prompt line |
|---|---|
| **0** | `Phase 0 — foundation: Prisma migrate, seed (docs/11 §3), JWT auth with refresh rotation, company/FY/series/chart-of-accounts, audit log, role guards, app shell with desktop sidebar and mobile bottom tabs.` |
| **1** | `Phase 1 — sales: customers, projects, service items, invoice CRUD with DB-allocated numbering, the three tax modes, PDF render worker, receipts with TDS-on-receipt, AR ageing. Port templates/invoice/tax-invoice.html as the React template.` |
| **2** | `Phase 2 — GST: LUT register with the FY guard, input/output GST ledgers, GSTR-1 and GSTR-3B export for the CA (CSV, not portal filing), HSN/SAC summary, QRMP-aware periods.` |
| **3** | `Phase 3 — purchases: vendors with foreign-supplier/RCM flags, vendor bills, self-invoice generation, bill payments, AP ageing, expenses with s.17(5) ITC blocking, recurring expenses.` |
| **4** | `Phase 4 — payroll: 4 employees incl. the director, salary structures, monthly run, s.192 TDS (CA supplies the annual estimate, system prorates), Kerala profession tax, payslip PDF, StaffAllocation feeding project cost.` |
| **5** | `Phase 5 — TDS payable: rate resolver with s.197 and s.206AA, retrospective threshold crossing, challans with CIN, deductee-wise 24Q/26Q/27Q CSV export, pre-flight validator, interest and 234E calculator, compliance calendar.` |
| **6** | `Phase 6 — TDS receivable: booking on receipt, ageing by client/section/quarter, Form 26AS import and reconciliation, Form 16A chase list.` |
| **7** | `Phase 7 — banking: Axis CSV/XLS import with BankProfile column mapping, dedupe hash, opening/closing balance check that rejects the batch on mismatch, the tiered match engine (docs/02 §A3) including the TDS-aware tier, BankRule learning loop, BRS, mobile swipe reconciliation.` |
| **8** | `Phase 8 — reports: P&L, balance sheet, trial balance, cash flow, project P&L, client P&L, AR/AP ageing. Every figure drills through to journal lines.` |
| **9** | `Phase 9 — mobile polish: offline expense queue, camera OCR, push notifications, biometric re-auth, WhatsApp share, dashboard aggregation endpoint.` |

---

## Guardrails to repeat when the build drifts

Paste these when you see the failure they describe. All are common.

| If you see | Say |
|---|---|
| `number` or `parseFloat` on money | "Money is Prisma Decimal. Replace every float path and add a lint rule banning parseFloat in src/server." |
| Invoice number built in TypeScript | "Numbering must come from DocumentSeries under SELECT FOR UPDATE inside the transaction. Add the 50-parallel-create test." |
| Hard-coded `0.18` or `10` for a rate | "Rates come from TdsSectionRate/GstRate via rateAsOf(code, date). No literals." |
| `prisma.invoice.delete` | "Nothing is hard-deleted. Cancel and post a reversal." |
| Tax mode as a dropdown | "Tax mode is derived from customer.country and stateCode. Display it, never offer it." |
| Export invoice without a LUT check | "Block sending. A missing LUT for the invoice FY is an error, not a warning." |
| `companyId` read from the request body | "companyId comes from the JWT only. Fix the repository layer." |
| A table that scrolls sideways on mobile | "Below 768px this becomes cards. See docs/13 §3." |
| PDF generated in a route handler | "PDF goes to the BullMQ worker. Requests must not block on Chromium." |
| Rounding with `toFixed` | "Decimal.toDecimalPlaces(2, ROUND_HALF_UP), per line, then sum." |

---

## Before the first live invoice

A release checklist, not a build step:

- [ ] `07-tds-rates.ts` rates and thresholds **confirmed by the CA**
- [ ] SAC code settled — `998314` vs `998519` for staff augmentation
- [ ] **LUT for FY 2026-27** filed and entered, or exports switched to with-IGST
- [ ] PAN collected and verified for all 9 freelancers
- [ ] Legacy invoices 1–25 imported as reserved numbers
- [ ] Opening balances entered as at the cutover date, trial balance agrees
- [ ] Shinelal's s.192 annual estimate supplied by the CA
- [ ] Board resolution on file authorising the invoice signatory
- [ ] GST registration amended (REG-14) for the current directors
- [ ] AWS / GoDaddy / DigitalOcean accounts carry Adpedia's GSTIN
- [ ] One real invoice raised, PDF checked against `templates/invoice/tax-invoice.html`
- [ ] One real bank statement imported and reconciled end to end
