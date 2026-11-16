# 95 · Hardening — what a review of the code found, and what closed it

A read-through of the whole repository, then the application run end to end (sign in, customer,
invoice, send, PDF, ledger), found nothing that stopped it working and eight things that would
have hurt later. None of them was a bug in a screen; every one was a place where the system
relied on someone remembering.

## 1. A template for the environment, and one place that checks it

🔴 `.env.example` had been deleted in the last commit, while the README and docs/90 both say
`cp .env.example .env`. It is back, with `CRON_SECRET` added (it was documented in docs/90 and
absent from the template).

Eleven variables were read straight from `process.env` at the point of use. A typo in one of them
surfaced as a failure in whichever feature touched it first — a passkey prompt that would not
verify, a scheduler that answered 503 — never as a refusal to start. They are all in the schema in
`src/lib/env.ts` now, and `src/instrumentation.ts` reads it when the server starts, so a
misconfigured box does not start and says why in the pm2 log.

What is checked is that a value which **is** set is one the feature can use:

- `CRON_SECRET` ≥ 16 characters; `WEBAUTHN_ORIGIN` is a scheme and a host with no path —
  `new URL('localhost:3000')` is *valid* (scheme `localhost:`), so `.url()` alone passed the one
  typo this exists to catch; the VAPID keys are set together or not at all; the switches
  (`FX_LIVE_RATES`, `IRP_MODE`, `EINVOICE_ENABLED`, `STORAGE_DRIVER`) are one of their values.
- In production, additionally: `WEBAUTHN_ORIGIN` must be `https://` and `STORAGE_DRIVER=s3` is
  refused (not implemented, docs/38 §6).
- An empty value is "not set", which is how `.env.example` ships `VAPID_PUBLIC_KEY=`.

The runtime reads stay where they are. Two tests flip `FX_LIVE_RATES` and `EINVOICE_ENABLED`
between cases, which a cached value would ignore.

## 2. Failed sign-ins are counted

🔴 `/api/auth/login` had no limit of any kind. Argon2id makes a guess cost about 50 ms, which
slows a brute force and does not stop one. **Eight failures inside fifteen minutes lock the
address for fifteen minutes** (`src/server/auth/throttle.ts`, table `LoginThrottle`).

- **Keyed by email, not by IP.** `clientMeta()` takes the first `x-forwarded-for` entry, which
  behind the nginx in docs/90 (`$proxy_add_x_forwarded_for`) is whatever the client sent. An IP
  key falls to one header; an email key cannot be rotated around.
- **Counted whether or not the address is an account**, or "locked" would be the answer for exactly
  the addresses that exist.
- **A lock refuses the correct password too**; otherwise it is a delay for the guesser who carries on.
- The count is one atomic upsert, so eight parallel guesses cannot all read "seven".
- A good sign-in clears the count. A locked address answers `429` with `Retry-After`; the login page
  already prints the server's message.

The cost, accepted: anyone who knows an address can keep it locked, fifteen minutes at a time. A
session already signed in is unaffected, and it clears itself. That was judged better than an
unthrottled password on a finance system. Passkey sign-in is not affected — it needs a session.

## 3. The ledger's second check covered the entry and not the lines

docs/10 §3.1 promises two independent balance checks. The database one fired on `JournalEntry`
only, so after commit a `DELETE` on one line, an `UPDATE` of an amount, or an `INSERT` of a
one-sided line passed unremarked. The application never does any of these.
`20261116130000_journal_line_protection` makes the database refuse them:

| | |
|---|---|
| `journal_line_must_balance` | deferred, on line insert/update: the entry must balance at COMMIT |
| `no_delete_journal_line` | a posted line is never deleted (design rule 2) |
| `no_rewrite_journal_line` | account, amount and entry cannot change; party and project columns can, because `ON DELETE SET NULL` writes them |

**Not closed:** adding a *balanced* pair of lines to an already-posted entry still passes. Telling
"the same transaction as the entry" from "a later one" in SQL is not reliable across versions, and a
wrong rule here would refuse real postings. Someone with a database login can still alter the books;
what changed is that a mistake or a stray script can no longer do it by accident.

`tests/party-ledger…` used to prove its detector by bolting an unbalanced line onto a posted entry and
deleting it. That is exactly what is now refused; it posts a separate balanced entry instead.

## 4. Company isolation no longer depends on memory

`scripts/scope-sweep.mts` (docs/82) found 106 queries on company-scoped models with no company
filter, and nothing ran it. They are scoped now — `where: { id, companyId }`, which Prisma accepts on
unique lookups — and `tests/scope-sweep.test.ts` fails the build on the next one.

Most were safe by construction (an `update` on a row read a line earlier through a scoped query).
One was fragile: `createBill` read the vendor by id alone and was protected only because
`previewBill`, called first, scoped it. Every one that was traced was protected by an earlier scoped
read, and none was demonstrated to leak — but not all 106 were traced one by one, and "safe because of
what the caller did first" is not a property a second company can rely on. Hence scoping them all.

🔴 The sweep itself had a hole, found while turning it into a test: it passed a call if `companyId`
appeared **anywhere** in its arguments, including a nested `include.where` for another model. It now
reads the call's own top-level `where`, resolves `...spreads` and pre-built filters, and has a
neutering test (a query that forgot the filter, one whose filter sits in a nested `where`).

Three queries are company-less on purpose, each with its reason beside it in the test:
invitation acceptance (by secret token, by somebody with no account), the user's own membership
count and list (across companies, which is the switcher's job), and the bank-transaction dedupe hash
(already includes the bank account, which has one company).

## 5. CI, and a script that could write into the real ledger

`.github/workflows/ci.yml` runs typecheck, lint, the unit tests (which now include the sweep) and
the integration suite against Postgres 16 on `localhost:5461`, the address the scripts expect.

🔴 `scripts/tmp-fullseed.mts` raises a dozen invoices, notes, receipts and bills against whatever
`DATABASE_URL` points at, finding its company by the real PAN. Production and development are both
named `adpedia` (docs/90 step 4), so the name cannot tell them apart; the port can. It now refuses
unless the target is `localhost:5461` or a `*_test` database, or is named exactly in
`ALLOW_FULLSEED_ON=host:port/db`, and refuses `NODE_ENV=production` outright.
Nothing financial can be deleted afterwards, so a wrong run cannot be undone.

## 6. Housekeeping

- README said 42 models (67), and the handover said 1,028 tests (1,453: 610 unit + 843 integration, of which this
  work added 30 and 19). Both are corrected.
- README listed docs/90 after docs/94.
- `ADPEDIA-logo.svg` at the root was byte-identical to `public/brand/adpedia-logo.svg` and
  `templates/invoice/assets/adpedia-logo.svg`; removed. `sign.png` is **not** a duplicate — it is the
  client's original, which docs/03 says was broken and was cleaned into `signature.png` — so it moved
  to `templates/invoice/source/` rather than being deleted.
- The four lint warnings are gone, so CI starts clean.
- `next build` warns that the middleware bundle uses `setImmediate`: `middleware.ts` imports `ACCESS_COOKIE` from
  `server/context`, which pulls the Prisma client into the edge bundle, against its own comment that it "must not hit
  Prisma". Not changed here; it is harmless today and worth a one-line constant in a module of its own.

## 7. What was not code

The handover's §1 blockers — PANs for 13 people, annual tax estimates, the FY 2026-27 LUT, the CA's
sign-off on the TDS table, the profession-tax notification, the SAC choice — need the client or their
CA. Nothing here changes them, and the system still cannot give a right answer until they arrive.

## 8. One thing seen while running it, not changed

PDFs rendered in the review sandbox logged "rendered without the document typeface … Is
fonts.googleapis.com reachable?". The box that renders invoices needs outbound HTTPS to Google Fonts
or the layout will not match the template. docs/33 and docs/90 already say Chromium is needed; this is
the same dependency, one hop further out.
