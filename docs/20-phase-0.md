# 20 · Phase 0 — Foundation

**Status: done and verified against a live database.**
Lint clean · typecheck clean · production build passes · **47 tests pass**
(36 unit + 11 integration) · migrations applied · seed loaded · auth exercised end to end.

---

## 1. What shipped

| Area | Files |
|---|---|
| **Money** | `src/lib/money.ts` — Decimal, `round2`/`round0`, `halveTax`, Indian grouping, `amountInWords` |
| **Financial years** | `src/lib/fy.ts` — FY labels, bounds, TDS quarters, deposit due dates |
| **Env** | `src/lib/env.ts` — zod-validated, fails loudly at first use |
| **Auth** | `src/server/auth/` — argon2id, JWT (jose), refresh rotation with family revocation |
| **Context** | `src/server/context.ts` — `companyId`/`role` from the token, `tokenVersion` checked against the DB |
| **Permissions** | `src/server/auth/permissions.ts` — the docs/13 §1.1 matrix, `assertNotReadOnly` |
| **Isolation** | `src/server/repositories/scoped.ts` — the single place `companyId` is applied |
| **Ledger** | `src/server/services/accounting/` — `assertBalanced`, `postJournal`, `reverseJournal`, `assertPostable` |
| **Audit** | `src/server/audit.ts` — append-only |
| **API** | `/api/auth/{login,refresh,logout,me}` |
| **Shell** | Sidebar + role-shaped mobile bottom tabs + topbar, brand `#4135AF`, Poppins |
| **Schema** | `prisma/schema.prisma` — 42 models, validated |
| **Migrations** | `20261001000000_init` (1,188 lines) + `20261001000001_journal_balance_trigger` |
| **Seed** | `prisma/seed/` — company, FYs, series, 55 accounts, bank, LUTs, TDS rates, expense categories, owner user |

## 2. The two database-level guarantees

Application code can be bypassed — a raw SQL insert, a migration, a future service.
These cannot be:

```sql
-- every journal entry balances, checked at COMMIT
CREATE CONSTRAINT TRIGGER journal_entry_must_balance
  AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- financial records are never hard-deleted
CREATE TRIGGER no_delete_invoice BEFORE DELETE ON "Invoice"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
```

Plus a `CHECK` on `JournalLine` that a line is single-sided and non-negative, and an
append-only guard on `AuditLog`.

`assertBalanced()` in TypeScript is the first of the two checks. Both are deliberate.

## 3. Tests — 36 passing

| File | Covers |
|---|---|
| `money.test.ts` | rounding, the per-line-then-sum rule, Indian grouping, amount in words, a property test that CGST+SGST never loses a paisa |
| `journal.test.ts` | balance assertion, the real Adpedia postings (invoice, receipt-with-TDS, DigitalOcean RCM, payroll), a property test over arbitrary amounts |
| `fy.test.ts` | FY boundaries using the real invoice dates, TDS quarters, the 30-April March rule |
| `permissions.test.ts` | the full matrix, including auditor read-only |
| `scope.test.ts` | isolation, no-delete, auditor write block |

One test caught a real thing worth recording: three lines of `33.333` round to `99.99`
per line but `100.00` if summed first. The per-line figure is correct, because each
line's tax is printed on the invoice and has to be right on its own.

## 3b. Verified end to end

```
login                        200, user + company + role returned
cookies                      adp_at (httpOnly, path /) · adp_rt (httpOnly, path /api/auth)
/api/auth/me                 ADPEDIA FILMS PRIVATE LIMITED · GSTIN 32AAUCA9985H1ZX · FY 2026-27 · OWNER
wrong password               401
unauthenticated /me          401
refresh                      200, token rotated (old != new)
replay the OLD token         401 "Session revoked" — family revoked
the NEW token afterwards     401 — whole family dead, theft contained
stored refresh tokens        sha256 hashes only, plaintext never persisted
```

Database triggers proven to fire, not just written:

```
balanced entry               accepted
off by one paisa             REJECTED  "unbalanced: debit ... <> credit ..."
entry with no lines          REJECTED  "has no lines"
line with debit AND credit   REJECTED  CHECK constraint
DELETE a journal entry       REFUSED   "never hard-deleted"
UPDATE an audit log row      REFUSED   "append-only"
duplicate invoice number     REJECTED  unique (companyId, number)
```

Seed state after a clean run: 55 accounts · 6 document series · 2 LUTs · 1 user ·
**0 transactions** · next invoice `ADP/26-27/0026`.

## 4. Setup

```bash
cp .env.example .env          # set JWT_SECRET; DATABASE_URL is pre-filled for local dev
npm install
npm run pg:start              # project-local Postgres on :5461, data in ./.pgdata
npm run db:migrate            # applies both migrations
npm run db:seed               # company, accounts, rates, owner user
npm run dev
```

| Script | Does |
|---|---|
| `npm run pg:start` / `pg:stop` | project-local Postgres, port 5461 |
| `npm test` | 36 unit tests, no database needed |
| `npm run test:db` | recreates `adpedia_test`, migrates, seeds, runs 11 integration tests |
| `npm run test:all` | both |

### Why a project-local database

This Mac already had **PostgreSQL 17** installed system-wide (plus two project-local
instances from other projects). Installing a third via Homebrew would have been
wasteful, and connecting to the system one needs its superuser password.

So the project runs its own cluster in `./.pgdata` on port **5461** via
`embedded-postgres` — no system install, no shared credentials, nothing to clean up
beyond deleting a folder. `.pgdata` is gitignored. Production just takes a real
`DATABASE_URL`; nothing in the code knows the difference.

**Integration tests use a separate `adpedia_test` database**, recreated on every run.
They must — the no-delete triggers mean test rows cannot be cleaned up afterwards,
which is the system working correctly.

`npm run db:seed` prints a generated owner password unless `SEED_OWNER_PASSWORD` is set.
The dev account is recorded in `.env`, which is gitignored.

## 5. What Phase 0 deliberately does NOT do

No invoices, no customers, no tax computation, no PDF, no banking. The dashboard shows
foundation state only. Those are phases 1–9 in `10-spec-overview.md` §5.

## 6. Carried into Phase 1

- 🔴 **TDS rates in `prisma/seed/tax-rates.ts` are placeholders.** Confirm with the CA

> **Superseded:** the rates and slabs were filled in later — see [32-tax-rates.md](32-tax-rates.md). They are statutory as at 01 Apr 2025 and still need the CA's sign-off.
  before any live deduction.
- 🔴 **No LUT on file for FY 2026-27.** The seed records 2024-25 and 2025-26. The
  dashboard shows this in red, and export invoices must stay blocked until it is filed.
- ⚠️ **TAN `CHNA09808A`** was read from a PDF where the glyphs were partly clipped. Verify.
- ⚠️ **SAC code** — `998314` vs `998519`. `showSacOnInvoice` is seeded `false`.
- Legacy invoices 1–25 still need importing as reserved numbers before the first
  Phase 1 invoice is raised.
