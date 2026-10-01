# 00 · Handover — read this first

Adpedia Films Private Limited's internal finance ERP. **528 tests** (293 unit + 235
integration), typecheck and lint clean, production build passes.

Everything below is either hard-won or non-obvious. The per-module detail is in `docs/20`
onward; `README.md` indexes all of it.

---

## 1. 🔴 What is still blocking real use

None of these are code. All need the client or their CA, and the system is correct without
them — it just cannot produce a right answer until they arrive.

| | Why it blocks |
|---|---|
| **PANs for 13 people** (4 employees, 9 freelancers) | Without one, s.206AA forces 20% instead of the section rate, Form 16/16A cannot be issued, and the 4th character is the only reliable source for 194C at 1% vs 2%. Enter at `/tax/pan`. |
| **Annual tax estimates per employee** | s.192 prorates the CA's estimate across remaining months. Nothing is deducted until it is entered, and under-deduction carries 1% a month. |
| **FY 2026-27 LUT ARN** | Exports are blocked by design. An export raised zero-rated without a current LUT is simply not zero-rated and the IGST becomes payable. |
| **CA sign-off on the TDS table** | `docs/32`. The rates are statutory as at 01 Apr 2025, stated to the best of my knowledge, and must be rechecked against the Finance Act 2026. |
| **Chalakudy's profession tax notification** | Slabs are set by the local body. |
| **998314 vs 998513 for staff augmentation** | A judgement call on who directs the work, per contract. `docs/34 §3`. |

## 2. Verified facts about the company

Confirmed by the client against the PAN card, GST REG-06 and MCA certificate. **Do not
re-derive these.**

- Legal name **ADPEDIA FILMS PRIVATE LIMITED** · PAN `AAUCA9985H` · GSTIN `32AAUCA9985H1ZX`
- CIN `U92190KL2021PTC068241` · TAN `CHNA09808A` ⚠️ *partly clipped in the source PDF — verify*
- 🔴 Address is **VIII/318**, not VIII/308. The old invoices are wrong; the register is right.
- Invoice series continues at **ADP/26-27/0026**
- LUT ARNs on file: `AD320324005917B` (FY 2024-25), `AD320325043063O` (FY 2025-26)
- Kerala, state code **32** · QRMP quarterly filer
- Exports: yes · Shinelal is a director paid **as salary** (s.192) · Akash, Deepak, Kiran are
  employees · everyone else is a freelancer
- AWS India and GoDaddy India are normal ITC; **DigitalOcean is foreign → reverse charge**

## 3. 🔴 Design rules that must not be broken

Each was decided for a reason and several were learned from a bug.

1. **Money is `Decimal`, never a float.** Round per line, then sum.
2. **Nothing financial is hard-deleted.** A database trigger refuses it. Cancel and post a
   reversal; both entries stay.
3. **Every posting goes through `postJournal`**, which calls `assertPostable`. That is what
   makes the period lock and the year-end close work everywhere at once.
4. **Reports read journal lines, never source documents.** One set of numbers.
5. **Rates come from effective-dated rows via `rateAsOf(code, date)`.** A change is a NEW ROW,
   never an edit — a document must keep reproducing the rate that applied when it was raised.
6. 🔴 **Issued documents are frozen.** Invoices snapshot their bill-to details at send
   (`docs/41`); filed returns snapshot their figures (`docs/44`). Correcting a customer must
   never rewrite an invoice already with the client.
7. **Tax mode is derived from country and state code.** Displayed, never offered.
8. **Nothing a user uploaded is ever served inline** (`docs/38`).

## 4. 🔴 Compliance subtleties that are easy to get wrong

Each of these is implemented and tested; each was wrong in an obvious first attempt.

- **TDS deposit is the 7th — except March, which is 30 April.** The TDS return is the last day
  of the following month — except Q4, which is 31 May.
- **TDS interest is per month *or part of a month*; GST interest is per *day*.** Applying the
  TDS rule to a one-day GST delay overstates it ~30×.
- **GST interest runs on the cash component**, not the gross — the proviso to s.50(1).
- **Kerala files quarterly GSTR-3B on the 24th**, not the 22nd.
- **A March supply is in the SAME financial year as the previous April.** The s.34(2) credit
  note deadline for a 15 Mar 2027 invoice is 30 Nov 2027, not a year later.
- **Advance tax percentages are cumulative**, not per instalment.
- **CGST and SGST are two halves of one tax** — a receipt OCR must add them, not take one.
- **Profession tax caps at ₹2,500 a year** under Article 276(2).
- **RCM must be paid in cash**, never set off against ITC.
- **The LUT is due *before* the year it covers.**

## 5. Environment quirks

- **No poppler.** Read PDFs with JXA + PDFKit. `head` is shadowed — always `/usr/bin/head`.
- **`.next` is shared by build and dev.** Running a build while the dev server is up breaks
  it with `Cannot find module './897.js'`. Stop the server, `rm -rf .next`, restart.
- **Chromium must be installed** for PDF rendering: `npx playwright install --with-deps chromium`.
- **Postgres** runs project-local on port 5461 via `npx tsx scripts/pg.ts start`.
- `npm test` is unit only; `npm run test:db` recreates the test DB and runs integration.
- Dev credentials live in `.env` (gitignored) and are never repeated in chat.
- A stale dev server sometimes holds port 3000 and the new one silently starts on 3001 —
  check the log line before assuming a 404 is real.

## 6. How the last several modules were chosen

Not from a wishlist. Each was found by surveying for a specific class of gap, and the method
kept working:

- **services with no UI caller** → found manual receipts (`docs/39`)
- **documents that post journals but cannot be cancelled** → corrections (`docs/40`)
- **what an obvious feature would break** → found that editing a customer rewrote issued
  invoices (`docs/41`)
- **error messages pointing at things that do not exist** → credit notes (`docs/42`)
- **obligations with deadlines nothing tracked** → compliance calendar (`docs/43`)
- **models that exist but nothing writes to** → GST filing records (`docs/44`), then payments
  (`docs/45`)

🔴 **Three times, rendering the output and looking at it found bugs the tests did not** — a
broken logo, stray IGST rows on a Kerala invoice, a two-page A4 layout. Tests asserted
figures and HTML substrings; the document was arithmetically perfect and still wrong.

## 7. The largest remaining gaps

In rough order of value:

- **Electronic cash/credit ledgers** are not modelled (`docs/45`)
- **Credit-note PDF** — the renderer is invoice-shaped, so this is a template job
- **Vendor and project edit pages** — services and audit done, pages missing (`docs/41`)
- **Unmatching a bank line** has a service and no button (`docs/40`)
- **Payroll runs and TDS challans cannot be cancelled** — heavier downstream consequences, so
  they want their own thinking rather than the pattern applied blindly
- **Debit notes** (s.34(3)), **advance receipts**, **expense attachment panel**, **PDF
  statements**, **journal/ledger export**, **service-item CRUD**
- **S3 storage driver** is deliberately unimplemented (`docs/38 §7`)
- **Live IRP client** is deliberately unimplemented (`docs/31 §6`)
