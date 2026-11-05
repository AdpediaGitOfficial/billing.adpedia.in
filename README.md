# Adpedia Finance ERP

Internal finance system for **Adpedia Films Private Limited** — billing, GST, TDS,
payroll, projects and bank reconciliation on a double-entry ledger.

## Read in this order

| | |
|---|---|
| **Discovery** | |
| [**00 · Handover**](docs/00-handover.md) | **Start here** — blockers, verified facts, design rules, environment quirks |
| [01 · Company profile](docs/01-company-profile.md) | Legal identity, GST, bank, seed data, open questions |
| [02 · Reconciliation, TDS, mobile, PDF](docs/02-recon-tds-mobile-pdf.md) | The original brainstorm + the Axis parser profile |
| [03 · Invoice audit & redesign](docs/03-invoice-audit-and-redesign.md) | What was wrong with the old invoices, and the new template |
| [04 · Expense categories & payees](docs/04-expense-categories.md) | Category→GST→TDS mapping, payee classification, RCM |
| **Specification** | |
| [10 · Overview & architecture](docs/10-spec-overview.md) | Stack, non-negotiables, build order, testing |
| [11 · Data model](docs/11-data-model.md) | Guide to `prisma/schema.prisma` |
| [12 · Accounting & tax engine](docs/12-accounting-and-tax-engine.md) | Chart of accounts, posting rules, GST, TDS |
| [13 · Screens & permissions](docs/13-screens-and-roles.md) | Navigation, roles, mobile behaviour |
| [14 · Build prompt](docs/14-build-prompt.md) | **Start here to build** |

## Build

| | |
|---|---|
| [20 · Phase 0](docs/20-phase-0.md) | Foundation — auth, ledger, period lock, audit |
| [21 · Phase 1](docs/21-phase-1.md) | Sales — customers, invoices, 3 tax modes, receipts, AR |
| [22 · Design system](docs/22-design-system.md) | Tokens, validated palette, charts, responsive rules |
| [23 · Phase 2](docs/23-phase-2.md) | GST — ledger position, QRMP periods, GSTR-1/3B export, LUT register |
| [24 · Phase 3](docs/24-phase-3.md) | Purchases — vendors, bills, TDS resolver, reverse charge, expenses |
| [25 · Phase 4](docs/25-phase-4.md) | Payroll — s.192, profession tax, allocation, project P&L |
| [26 · Phase 5](docs/26-phase-5.md) | TDS compliance — challans, interest, 24Q/26Q/27Q, pre-flight validator |
| [27 · Phase 6](docs/27-phase-6.md) | TDS receivable — Form 26AS import, reconciliation, Form 16A chase |
| [28 · Phase 7](docs/28-phase-7.md) | Bank reconciliation — statement import, the TDS-aware matcher, learned rules |
| [29 · Phase 8](docs/29-phase-8.md) | Reports — P&L, balance sheet, cash flow, trial balance, ageing, drill-through |
| [30 · Phase 9](docs/30-phase-9.md) | Mobile — offline expense queue, receipt OCR, passkeys, push, share |
| [31 · Phase 10](docs/31-phase-10.md) | E-invoice readiness — turnover monitor, IRP payload + validator, adapter (gated off) |
| [32 · Tax rates](docs/32-tax-rates.md) | TDS sections and Kerala profession tax slabs — statutory, pending CA sign-off |
| [33 · PDF renderer](docs/33-pdf-worker.md) | Invoice PDFs via headless Chromium — and the three invoice bugs it found |
| [34 · SAC codes](docs/34-sac-codes.md) | Film, advertising, IT and staffing codes, with validation on the invoice form |
| [35 · Missing screens](docs/35-missing-screens.md) | Receipts, approvals, projects, payslips, company and users — the six dead nav links |
| [36 · Report exports](docs/36-report-exports.md) | CSV for the CA — and the formula-injection gap it closed in the GST/TDS exports too |
| [37 · Closing the books](docs/37-closing-the-books.md) | Period lock, year-end close, reopen-by-reversal, next-year numbering |
| [38 · Document storage](docs/38-document-storage.md) | Receipts and bills actually stored — magic-byte checks, hostile serving, soft detach |
| [39 · Manual receipts](docs/39-manual-receipts.md) | Recording money by hand, with the TDS split proposed — and attachments made visible |
| [40 · Corrections](docs/40-corrections.md) | Reversing receipts, payments, expenses and bank matches — and the aggregates that had to follow |
| [41 · Editing master data](docs/41-editing-master-data.md) | Edit screens — and freezing bill-to details so they cannot rewrite issued invoices |
| [42 · Credit notes](docs/42-credit-notes.md) | s.34 credit notes — closing a dead end, and filling GSTR-1's empty cdnr table |
| [43 · Compliance calendar](docs/43-compliance-calendar.md) | What is due and when, derived from the books — and the four dates that are not what they look like |
| [44 · GST filing records](docs/44-gst-filing-records.md) | Recording a return as filed — which locks the period, and makes the calendar go quiet |
| [45 · GST payments](docs/45-gst-payments.md) | Challans, CIN vs CPIN, and why s.50(1) interest runs on the cash component |
| [46 · Electronic ledgers](docs/46-electronic-ledgers.md) | The cash and credit ledgers, head-wise set-off under s.49(5), and the netting that understated the cash |
| [47 · PAN cards](docs/47-pan-cards.md) | Upload the card, no online verification — and the s.206AA flag that was over-deducting for good |
| [48 · Credit note document](docs/48-credit-note-document.md) | The credit-note PDF under rule 53(1A) — and the post-deadline note that was recovering GST anyway |
| [49 · Services nothing could call](docs/49-reachable.md) | Three corrections, a passkey that could not be revoked, vendor and project edits — and the financial year everything thought it was in |
| [50 · Cancelling with consequences](docs/50-cancelling-payroll-and-challans.md) | Payroll runs and TDS challans — and the filing record that decides whether they may be reversed at all |
| [51 · Reversible](docs/51-reversible.md) | Credit notes and GST set-offs — the last documents that could not be undone, and the rule behind all of them |
| [52 · Amendments](docs/52-amendments.md) | GSTR-1 table 9A and TDS correction statements — what every refusal was pointing at |
| [53 · Debit notes](docs/53-debit-notes.md) | s.34(3) — the mirror of the credit note, and the three rules that are not mirrored |
| [54 · Advances](docs/54-advance-receipts.md) | Money in before an invoice — the receipt voucher, the GST that falls due on it, and rule 50 |
| [55 · Certificates](docs/55-certificates.md) | Form 16 and 16A — a register and a chase, because only TRACES may generate them |
| [56 · The portal](docs/56-portal-reconciliation.md) | Both electronic ledgers and every challan CIN, compared with what the department actually holds |
| [57 · Payslips](docs/57-payslips.md) | The document an employee asks for — and the five API routes that never asked who was reading |
| [58 · Statements](docs/58-statements.md) | P&L, balance sheet and journal exports — and whether a statement says it can still change |
| [59 · Issued documents](docs/59-issued-documents.md) | Keeping the invoice that was actually sent, and the bill behind every input-credit claim |
| [60 · Reminders](docs/60-reminders.md) | The deadlines, chases and approvals this system knew about and never told anyone |
| [61 · Chases](docs/61-chases.md) | Asking the people outside this company for the PAN, the certificate and the money |
| [62 · GSTR-2B](docs/62-gstr2b.md) | Which supplier did not file — input credit matched invoice by invoice |
| [63 · Reverse charge](docs/63-reverse-charge.md) | A caveat that said the figures could not be trusted, when they could |
| [64 · Document series](docs/64-document-series.md) | Every number issued, the holes in the run, and the rule-46 check nothing called |
| [65 · Refund vouchers](docs/65-refund-vouchers.md) | Giving an advance back, and recovering the GST declared when it arrived |
| [66 · Note amendments](docs/66-note-amendments.md) | Table 9C — and the deadline a credit note has that a debit note does not |
| [67 · Master data](docs/67-master-data.md) | The service catalogue and the company's own details — and the field nothing could set |
| [68 · The mobile tail](docs/68-mobile-tail.md) | Swipe with a real Undo, and the performance budget measured for the first time |
| [69 · Note registers](docs/69-note-registers.md) | The documents nothing listed, and a refund voucher filed under the advance's identity |
| [70 · Draft editing](docs/70-draft-editing.md) | Correcting a draft instead of cancelling it, and the financial year that moves with the date |
| [71 · Advance tax](docs/71-advance-tax.md) | s.211 instalments, the s.234C proviso, and a liability the books cannot derive |
| [72 · ROC filings](docs/72-roc-filings.md) | The AGM date every company-law deadline runs from, and which year it is about |
| [73 · Invitations](docs/73-invitations.md) | Inviting a user is creating a credential, and is held like one |
| [74 · Opening balances](docs/74-opening-balances.md) | The one position the system cannot derive, and the carry-forward that must stay derived |
| [75 · IRN on the document](docs/75-irn-on-the-document.md) | The signed QR, printed verbatim — and the mock IRN that must never reach a document |
| [76 · Annual filings](docs/76-annual-filings.md) | ITR and GSTR-9 for the year they are about, and something that can clear them |
| [77 · Membership](docs/77-membership.md) | Removing somebody and changing a role — and the role that was read from the token |
| [78 · Pagination](docs/78-pagination.md) | The lever docs/68 measured, and the total order a paginated list needs |
| [79 · Domestic reverse charge](docs/79-domestic-reverse-charge.md) | Why 1240 stays one account, what would change that, and the silence it leaves |
| [80 · The bug hunt](docs/80-bug-hunt.md) | Errors that vanished from nine file routes, a caller docs/72 never added, and a fixture lookup that passed by luck |
| [81 · Project money & ledgers](docs/81-project-money.md) | **Spec, not built** — three answers to "what do I get", direct margin, and a clear ledger per project, vendor and client |
| [82 · Two entities, one login](docs/82-two-entities.md) | A second entity kept genuinely independent — the leak sweep that came first, a bill of supply, the GST screens refused rather than hidden, and drawings that never touch the P&L |
| [83 · Mobile navigation & the session](docs/83-mobile-and-session.md) | A tab bar whose fifth slot led nowhere, a net loss that read as a profit, actions off the right-hand edge, one invoice rendering two documents, the number format nothing could set, a month-by-month view — and the dev database a test wiped because nothing checked its name |
| [84 · Party ledgers](docs/84-party-ledgers.md) | A running account with every client, vendor and sub-contractor — the reconciliation that is the point of it, and the dollars this found sitting in a rupee account |
| [85 · The document that would not download](docs/85-the-document-that-would-not-download.md) | A 500 on a deployed invoice: an archived copy that was fatal to read rather than rebuilt, a renderer that could not say it was missing, a screen that threw the server's explanation away — and the health route docs/90 listed as a known gap |
| [90 · Deployment](docs/90-deployment.md) | Step by step on a plain Ubuntu box — npm, pm2, Postgres, nginx, Chromium, the daily run, backups. No Docker |

**1,271 tests passing** · typecheck and lint clean · production build passes.

```bash
cp .env.example .env     # set DATABASE_URL and JWT_SECRET
npx playwright install --with-deps chromium   # ~100MB, needed to render invoice PDFs
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

## Assets

- `prisma/schema.prisma` — 42 models, validated
- `templates/invoice/tax-invoice.html` — GST invoice, three tax modes, print-correct A4
- `templates/invoice/assets/` — logo (SVG), signature (transparent PNG)

## Blocking before go-live

See the checklist at the end of [14 · Build prompt](docs/14-build-prompt.md). The three
that matter most:

1. **TDS rates and thresholds confirmed by the CA** — everything else is placeholder
2. **SAC code** — `998314` vs `998519` for staff augmentation
3. **LUT for FY 2026-27** — without it, exports cannot be zero-rated
