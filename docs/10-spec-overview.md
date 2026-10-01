# Adpedia Finance ERP — Development Specification
## 10 · Overview, Architecture & Non-Negotiables

Everything here is grounded in the confirmed facts in `01-company-profile.md`,
`03-invoice-audit-and-redesign.md` and `04-expense-categories.md`. Where something is
still open it is marked ⚠️ and given a safe default.

---

## 1. What is being built

An internal finance system for **Adpedia Films Private Limited** covering the full chain:

```
Client → Project → Invoice → Receipt → Bank
                     ↓          ↓
                    GST        TDS receivable
                     
Vendor/Staff → Bill/Payroll → Payment → Bank
                     ↓            ↓
              GST + RCM      TDS payable
                     
                All of it → General Ledger → P&L, Balance Sheet, Project P&L
```

Not a billing app with reports bolted on. A **double-entry ledger** with billing,
payroll, tax and reconciliation as the things that write to it.

### Scale it must handle (measured, not guessed)

| | Today | Design for |
|---|---:|---:|
| Invoices / month | ~3 | 50 |
| Bank lines / month | ~25 | 500 |
| Payroll | 4 | 25 |
| Freelancers | 9 | 50 |
| Turnover | ~₹39L | ₹5 Cr |
| Users | 2–3 | 15 |

This is a **small-data system**. Optimise for correctness and clarity, not throughput.
No sharding, no event sourcing, no microservices. A single Postgres database with
well-designed tables will carry this business for a decade.

**At ₹5 Cr turnover two things switch on** — 6-digit HSN/SAC, and **e-invoicing (IRN/QR)**.
Both are schema hooks now (`Invoice.irn`, `ackNo`, `signedQr`), unimplemented.

---

## 2. Stack

| Layer | Choice | Note |
|---|---|---|
| Framework | **Next.js 15, App Router, TypeScript** | One app, not two |
| UI | **Tailwind + shadcn/ui** | |
| Backend | **Node.js** — Next.js route handlers + server actions | Confirmed by client |
| Database | **PostgreSQL 16** | |
| ORM | **Prisma** | |
| Auth | **JWT access + refresh tokens**, argon2id, optional TOTP | Confirmed by client |
| Background jobs | **BullMQ + Redis** | PDF render, email, recurring expenses, reminders |
| PDF | **Playwright (headless Chromium)** in a worker | `03-invoice-audit-and-redesign.md` §D3 |
| Files | **S3-compatible** (DigitalOcean Spaces / R2) | Signed URLs, never public |
| Money | **`Decimal(18,2)`** via Prisma Decimal | 🔴 never float |
| Dates | **`DateTime` stored UTC**, rendered `Asia/Kolkata` | |
| Deploy | **DigitalOcean / AWS** | Confirmed by client |
| Mobile | **Responsive PWA** | Confirmed by client |
| Architecture | **Multi-company from day one** | Confirmed by client |

### Stack confirmed by client — one note on structure

The stack above is as specified. "Backend: Node.js" is satisfied by **Next.js route
handlers and server actions** — one deployable, not two. The business logic still lives in
a framework-free `src/server/services/**` layer that imports nothing from Next.js, so if a
standalone Node/NestJS API is ever genuinely needed, it lifts across without a rewrite.

Two things the list didn't name that the build needs:

- **Redis + BullMQ** for background jobs — PDF rendering, email, recurring expenses,
  payment reminders. PDF generation in particular must not run in a request.
- **Playwright (headless Chromium)** as the PDF engine. This is the "invoice/report
  generation service" in the list, made concrete.

---

## 2b. Authentication — JWT + refresh tokens

| | |
|---|---|
| Password hashing | **argon2id** |
| Access token | JWT, **15 min**, `HS256` (or `RS256` if a second service appears) |
| Refresh token | **Opaque random 32 bytes**, 30 days, stored **sha256-hashed** in `RefreshToken` |
| Transport | Both in `httpOnly` `Secure` `SameSite=Lax` cookies — never `localStorage` |
| Rotation | Every refresh issues a new token and revokes the old one |
| Theft detection | Reuse of an already-rotated token **revokes the whole family** |
| Global revoke | `User.tokenVersion` is in the JWT; bumping it invalidates every token |
| 2FA | Optional TOTP, enforced for `OWNER` and `ACCOUNTANT` |

The access-token payload carries `{ sub, companyId, role, tokenVersion }`. **Every query is
scoped by the `companyId` in the token**, never by one supplied in the request body — that
is the multi-company isolation boundary, and it must be enforced in the repository layer,
not in individual handlers.

Refresh tokens are stored hashed so a database leak cannot be replayed. Never log either
token.

## 3. Non-negotiables

These are the rules that must never be relaxed. Everything else is negotiable.

### 3.1 Every financial event produces a balanced journal entry

Enforced by a **database constraint**, not by discipline:

```sql
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS TRIGGER AS $$
DECLARE d NUMERIC(18,2); c NUMERIC(18,2);
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
    FROM "JournalLine" WHERE "journalEntryId" = NEW.id;
  IF d <> c THEN
    RAISE EXCEPTION 'Journal % unbalanced: debit % <> credit %', NEW.id, d, c;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

Run it as a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` so lines can be
inserted before the check fires at commit.

### 3.2 Nothing is ever hard-deleted

Cancel and reverse. A cancelled invoice keeps its number — gaps in a GST invoice series
must be explainable. No `DELETE` on any financial table; `deletedAt` only on drafts.

### 3.3 Invoice numbers are allocated by the database

Inside the same transaction that creates the invoice, via `SELECT … FOR UPDATE` on the
series row. Never by application code, never by a person. Two users creating invoices
simultaneously must not produce a duplicate — this already happened once manually
(invoice 11, twice — `03-invoice-audit-and-redesign.md` §2.1).

### 3.4 Tax rates are data, never code

Every GST rate, TDS rate and threshold lives in an **effective-dated table**. A rate
change is a row, not a deployment. Indian rates change most Februarys.

### 3.5 Periods lock

Once a month is reconciled and its GST return filed, back-dated edits are refused.
Corrections are reversal entries in an open period.

### 3.6 Full audit trail

Append-only `AuditLog` on every financial table: who, when, before, after. Never updated,
never deleted.

### 3.7 Money

`Decimal(18,2)` everywhere. Round **half-up** to 2 dp at each tax computation, then sum —
do not sum then round. Store the rounding difference explicitly as `roundOff`.

---

## 4. Multi-tenancy and financial years

**Multi-entity from day one**, even though there is one company today. Every financial
table carries `companyId`. The cost now is one column and one index; retrofitting it later
means touching every query.

**Financial years** are first-class rows (`FinancialYear`), not derived from dates:

```
FY 2026-27 · 01 Apr 2026 → 31 Mar 2027 · status: OPEN
FY 2025-26 · 01 Apr 2025 → 31 Mar 2026 · status: CLOSED
```

Every posting carries `financialYearId`. Invoice series reset per FY. LUTs are per FY.
TDS returns are per FY quarter. This is the spine of the whole system.

---

## 5. Module build order

Revised from `02-recon-tds-mobile-pdf.md` §F now that the payee and spend picture is known.

| Phase | Ships | Why here |
|---|---|---|
| **0** | Company profile, FY, chart of accounts, users/roles, audit log | Everything depends on it |
| **1** | Customers, projects, invoices, **branded PDF**, receipts, AR | First real value — you can bill |
| **2** | GST engine (3 modes), LUT register, GSTR-1 export | Closes the sales tax loop |
| **3** | Vendors, bills, **RCM + self-invoice**, AP, expenses | DigitalOcean and Afrizon need this |
| **4** | **Payroll** (4 people) + s.192 + staff allocation | Biggest single cost; makes project margin real |
| **5** | **TDS payable** — 194J/194C/195, challans, 24Q/26Q/27Q export | 4 return types, deadline-driven |
| **6** | **TDS receivable** + 26AS reconciliation | Recovers real money |
| **7** | **Bank import + reconciliation** (CSV/XLS first) | Needs 1–6 to have things to match |
| **8** | Reports — P&L, balance sheet, cash flow, project & client P&L | Depends on a clean ledger |
| **9** | Mobile polish, offline capture, push, recurring expenses | Broadest users, lowest risk |
| **10** | e-Invoice IRP, bank API feed, second entity | Only when triggered |

**Payroll moved from 6 to 4.** With four salaried people including the director, salary is
the largest cost line, and project margins are wrong without staff allocation.

**Reconciliation stays late (7).** A matcher with nothing to match against is a demo.

---

## 6. Repository layout

```
src/
  app/                          Next.js App Router
    (auth)/                     login, TOTP
    (app)/
      dashboard/  customers/  projects/  invoices/  receipts/
      vendors/    bills/      expenses/  payroll/
      banking/    gst/        tds/       reports/   settings/
    api/
      webhooks/                 payment gateway callbacks
      pdf/[type]/[id]/          render endpoints (worker-called)
  server/
    services/                   ← framework-free business logic
      accounting/               posting rules, journal builder
      tax/                      GST modes, TDS engine, rate resolver
      invoicing/                numbering, totals, PDF orchestration
      banking/                  statement parsers, match engine
      payroll/
    repositories/               Prisma access
    auth/
  components/
    ui/                         shadcn
    forms/  tables/  charts/
  lib/
    money.ts                    Decimal helpers, rounding, INR formatting
    fy.ts                       financial-year resolution
    validation/                 zod schemas shared client+server
prisma/
  schema.prisma
  migrations/
  seed/                         chart of accounts, tax rates, company profile
workers/
  pdf.worker.ts  email.worker.ts  recurring.worker.ts  reminders.worker.ts
templates/
  invoice/                      ← already built
  self-invoice/  payslip/  ledger-statement/  payment-advice/
```

**The `src/server/services/**` layer imports nothing from Next.js.** That is what keeps
the NestJS option open and makes the logic unit-testable without a server.

---

## 7. Testing — what actually must be tested

Not coverage targets. These specific things:

| Area | Test |
|---|---|
| **Journal balance** | Property test: every posting rule, random inputs, Σ Dr = Σ Cr |
| **Invoice numbering** | Concurrency test: 50 parallel creates → 50 distinct sequential numbers, no gaps |
| **GST mode** | Table test: Kerala→Kerala, Kerala→MH, Kerala→UAE, SEZ, unregistered B2C |
| **Tax rounding** | ₹85,000 @ 9%+9% → 7,650/7,650, not 7,650.00000001 |
| **TDS threshold** | Vendor crosses annual limit on bill 3 → retrospective on the full amount |
| **LUT guard** | Export invoice with no LUT for that FY → blocked, not warned |
| **Period lock** | Back-dated edit into a filed period → refused |
| **Reconciliation** | Replay the real Axis statement → expected match tiers |
| **RCM** | Foreign vendor bill → self-invoice + IGST payable + ITC, net zero |

Seed the test database from the **real Axis statement** and the **five real Prime
invoices**. Synthetic fixtures will not surface the cases that actually occur here.

---

## 8. Documents in this spec

| Doc | Contents |
|---|---|
| `10-spec-overview.md` | This file |
| `11-data-model.md` | Full Prisma schema |
| `12-accounting-and-tax-engine.md` | Posting rules, GST engine, TDS engine |
| `13-screens-and-roles.md` | Screen-by-screen UI, roles & permissions |
| `14-build-prompt.md` | Master build prompt for Lovable / Claude Code |
