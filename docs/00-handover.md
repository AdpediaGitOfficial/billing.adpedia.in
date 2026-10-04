# 00 · Handover — read this first

Adpedia Films Private Limited's internal finance ERP. **983 tests** (411 unit + 572
integration), typecheck and lint clean, production build passes.

Everything below is either hard-won or non-obvious. The per-module detail is in `docs/20`
onward; `README.md` indexes all of it.

---

## 1. 🔴 What is still blocking real use

None of these are code. All need the client or their CA, and the system is correct without
them — it just cannot produce a right answer until they arrive.

| | Why it blocks |
|---|---|
| **PANs for 13 people** (4 employees, 9 freelancers) | Without one, s.206AA forces 20% instead of the section rate, Form 16/16A cannot be issued, and the 4th character is the only reliable source for 194C at 1% vs 2%. Enter at `/tax/pan`, and upload a copy of the card while you are there (`docs/47`). |
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
- ⚠️ **Never asked: does any s.9(3) domestic reverse charge apply?** A goods transport agency,
  an advocate's fee, sponsorship or security services would all be reverse charge at
  **CGST + SGST**, not IGST, and nothing in this system can produce one. Nothing in the books
  suggests it has happened; it has also never been put to the CA — `docs/63 §3`.

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
9. **A challan funds the electronic cash ledger; a set-off discharges the liability**
   (`docs/46`). They are separate postings, and the ledgers are derived from journal lines
   head-wise — one account per major head, because the law is head-wise.
10. 🔴 **PANs are never checked online** (`docs/47`). `panVerified` means *furnished by the
    payee and format-valid*, which is what s.206AA turns on; `panEvidence` records what
    stands behind it, and a card copy never changes the rate.

## 4. 🔴 Compliance subtleties that are easy to get wrong

Each of these is implemented and tested; each was wrong in an obvious first attempt.

- **TDS deposit is the 7th — except March, which is 30 April.** The TDS return is the last day
  of the following month — except Q4, which is 31 May.
- **TDS interest is per month *or part of a month*; GST interest is per *day*.** Applying the
  TDS rule to a one-day GST delay overstates it ~30×.
- **GST interest runs on the cash component**, not the gross — the proviso to s.50(1).
- **Kerala files quarterly GSTR-3B on the 24th**, not the 22nd.
- 🔴 **Form 16 and 16A may only be generated by TRACES** (rule 31(1)) — `docs/55`. This
  codebase could render a convincing one in an afternoon and must not: it would carry no
  verifiable signature and would evidence a credit the department never saw. The register
  records the real one instead, and a certificate cannot exist before its return is filed.
- 🔴 **GST is payable on an advance for SERVICES.** s.13(2); the relief in Notification
  66/2017 covers goods only. The money arrives tax-INCLUSIVE (rule 50), the advance is a
  liability in `2400` rather than revenue, and absorbing it into the invoice reverses the tax
  it paid — head by head, as posted, because rule 50 may have charged IGST where the invoice
  charges CGST+SGST. `docs/54`.
- 🔴 **A debit note has NO deadline, and a credit note does.** s.34(2) time-bars credit notes
  only, because they reduce the government's tax. The debit note's tax falls in the month it
  is issued (s.34(4), so no interest for the gap), and the recipient's credit runs from the
  note's own date (s.16(4) as amended from 01 Jan 2021) — `docs/53`.
- **A March supply is in the SAME financial year as the previous April.** The s.34(2) credit
  note deadline for a 15 Mar 2027 invoice is 30 Nov 2027, not a year later.
- **Past that deadline a credit note carries NO TAX.** It still credits the client the same
  gross, but no output tax is debited and it is not reported in GSTR-1 — `docs/48 §1`.
- **Advance tax percentages are cumulative**, not per instalment.
- **CGST and SGST are two halves of one tax** — a receipt OCR must add them, not take one.
- **Profession tax caps at ₹2,500 a year** under Article 276(2).
- **s.206AA turns on whether the payee FURNISHED a PAN**, not on anyone verifying it. Keying
  the 20% off a verification step that does not exist over-deducts for good — `docs/47 §1`.
- **RCM must be paid in cash**, never set off against ITC.
- **The LUT is due *before* the year it covers.**
- **GST interest runs to the date the cash ledger is DEBITED** (rule 88B(1)), not to the date
  a challan funded it. Money parked in the cash ledger has paid nothing.
- **Credit is utilised HEAD-WISE.** CGST credit may never discharge SGST, nor SGST discharge
  CGST (s.49(5)(e) and (f)), and IGST credit must be exhausted before either is touched
  (rule 88A). Netting total credit against total output tax understates the cash payable.
- **A period is settled in the FOLLOWING period.** Anything that reads "movement on the tax
  account during the period" therefore picks up the previous period's payment — `docs/46 §4`.
- **An OLTAS CIN is BSR(7) + the date of tender as DDMMYYYY + the 5-digit serial.** Built the
  other way round it is the right length and the wrong number, and TRACES rejects the challan
  rather than the file, so every deductee on it silently loses their credit — `docs/56 §3`.
- **ITC is not available at all unless it appears in GSTR-2B** (s.16(2)(aa)). Credit the books
  have accrued and the portal does not hold is not a timing difference; claimed, it must be
  reversed with interest at 18% — `docs/56 §2`.

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
- **The PWA service worker no longer runs in development** (`docs/68 §6`). It used to, and it
  cached `/_next/static/` first on the grounds that those filenames are content-hashed — which
  is true of a build and false of `next dev`, so it served yesterday's chunk for ever and a UI
  change looked like it had not taken effect. A dev page now unregisters any worker an earlier
  session left behind. If you are looking at a stale app shell in a browser that visited this
  project before October 2026, unregister it once by hand. Test the worker itself with
  `npm run build && npm start`.

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
- **a flag nothing could ever set** → PAN cards (`docs/47`), where `panVerified` waited on a
  portal check this system will never make, and every PAN entered in the register meanwhile
  left the payee at 20%
- **what the system simplified away** → the electronic ledgers (`docs/46`), which turned out
  to be hiding a head-wise set-off bug that understated the cash payable, and a period
  position that counted the previous period's payment

🔴 **Every time, rendering the output and looking at it found bugs the tests did not** — a
broken logo, stray IGST rows on a Kerala invoice, a two-page A4 layout, a PAN box 60px wide
on a phone, a credit note whose legal declaration quoted the wrong invoice number, a
statutory deadline printed a day late. Tests asserted figures and HTML substrings; the
document was arithmetically perfect and still wrong.

🔴 **A filed document is superseded, never edited** (`docs/52`). GST reports the revised
particulars in a later return (table 9A); TDS files a correction statement that replaces what
the return says. Recording either is what makes the `docs/50` and `docs/51` refusals stop
refusing — and only as far as the correction actually goes.

🔴 **A document may be reversed until somebody outside this company has been told about it**
(`docs/51 §4`). Filing is the moment that changes — which is why the filing records in
`docs/44` and `docs/50` had to exist before the reversals could be decided at all.

🔴 **A regex sweep over call sites misses the shorthand.** `docs/49` replaced twenty-five
"newest open financial year" lookups and missed two written `{ companyId, status: 'OPEN' }`;
one of them took the whole GST page down. A test now greps for the pattern — `docs/51 §3`.

🔴 **"The quarter is filed, so nothing in it may be touched" is too blunt a guard**
(`docs/50 §2`). A run created after the return went in was never in its figures. Compare
against the filing SNAPSHOT: what may not happen is taking the quarter below what was
reported.

🔴 **"The newest OPEN financial year" is not the year you are in** (`docs/49 §4`). Next
year's row exists before April because numbering needs it; twenty-five screens read the
newest open row and jumped to it. Use `currentFinancialYear()`.

🔴 **A service with tests and no caller looks finished.** Docs/40 built four corrections and
shipped one button; the other three were unreachable for nine modules. The survey that finds
this is a script, not a memory — `docs/49 §1`.

🔴 **A field nothing can set is a field nothing exercises.** `ServiceItem.incomeAccountId`
held an account id and was fed to a function wanting a code, for thirty-three modules, because
the catalogue had no screen and the invoice form never linked a line to a service. Every rupee
of revenue posted to the fallback 4010 (`docs/67 §2`).

🔴 **An internal doc reference in user-facing copy is the review marker's cousin.**
`tests/marker-leak.test.ts` covers both now, with a named exemption for messages that only
reach somebody editing environment variables (`docs/67 §5`).

🔴 **A credit note has two deadlines and a debit note has one.** s.37(3) says when an
amendment may be REPORTED (30 Nov following the note's financial year); s.34(2) says whether
the relief is available at all (30 Nov following the INVOICE's). They come apart whenever a
note is issued in a later year than its invoice, and increasing a credit note past s.34(2) is
refused however open the reporting window is (`docs/66 §1`).

🔴 **A refund of an advance is not a credit note.** s.34 credits an invoice; a refunded
advance has none. s.31(3)(e) and rule 51 give it its own document, carrying the number and
date of the receipt voucher it refunds (`docs/65 §1`).

🔴 **Postgres will not use a new enum value in the transaction that added it.** An `ALTER TYPE
… ADD VALUE` and any `INSERT` referencing it must be separate migration files, because Prisma
runs each file in one transaction (`docs/65 §6`).

🔴 **A new document type needs its series backfilled.** The seed only runs on a fresh install,
and `allocateNumber` refuses with an instruction pointing at a Settings screen that does not
exist (`docs/65 §6`).

🔴 **A pure function can be as unreachable as a service.** `validateInvoiceNumber` had five
tests and no caller for fifty-four modules; `docs/49`'s sweep missed it because it was looking
for services, and an unused function leaves no dead screen behind to notice (`docs/64 §1`).

🔴 **Not every missing number is missing.** The invoice series opened at 26 because
twenty-five were raised by hand first, and a cancelled document keeps its number by design —
so neither is a gap. Only a number taken from the series with nothing behind it is
(`docs/64 §2`).

🔴 **A caveat is a claim, and has to be true.** `docs/56` warned every month that the
head-wise credit comparison was approximate because reverse-charge credit "is split across
heads". In this system every reverse charge is an import of services and therefore IGST, so
the figures were exact — and a reader who learns to discount one figure discounts the next
(`docs/63 §1`). The hedge is now derived from `1240`'s own entries, so it returns by itself if
a domestic reverse charge ever lands there.

🔴 **ITC is matched on GSTIN and the NORMALISED invoice number.** A supplier files `EX/300`
and the bill was typed `EX-300`; a literal comparison reports the whole purchase register as
unavailable credit. Amount is a fallback only — two invoices from one supplier for one amount
in one month is a retainer, and matching on amount crosses them over (`docs/62 §3`).

🔴 **An invitation is a credential.** 32 random bytes, only the sha256 stored, not in the audit
log, single-use, expiring — and accepting it creates NO session, because a link in an inbox that
signs you in is a password in an inbox. The public half gives one refusal for unknown, expired,
revoked and already-accepted alike, or it is an oracle; the inviter's half refuses by name,
because they can already read the list (`docs/73`).

🔴 **The middleware matcher is where a route silently disappears.** docs/30 §8 found the service
worker being redirected to /login, killing the offline queue, and left nothing behind to catch
it again. `tests/public-routes.test.ts` now checks both halves — whether the middleware RUNS for
a path, and whether it redirects (`docs/73 §5`).

🔴 **An annual obligation is about the year that has ENDED.** The AGM for FY 2026-27 is held
in 2027; what is live in October 2026 is FY 2025-26's, which was due five days ago. Keying it
off `currentFinancialYear` shows a date a year away and omits the one already late — docs/49
§4's trap asked of a different question (`docs/72 §2`).

🔴 **A deadline that runs from an event must be computed from the event, not from the event's
own deadline.** AOC-4 is thirty days from the AGM that was HELD; a meeting on 15 August makes
it due 14 September, six weeks before the 30 October anybody working from 30 September would
have written down (`docs/72 §1`).

🔴 **A modelled-but-unserviced field is the same gap as a service with no caller**, and it is
closed in the NEXT module rather than left in "still open". `cancelRefundVoucher` sat there for
four modules and by the time anybody returned to it the postings had been filed under the wrong
identity (`docs/72 §5`).

🔴 **The s.234C safe harbour is not a rounding of the instalment percentage.** 12% by 15 June
and 36% by 15 September forgive the INTEREST on a near miss, for the first two instalments
only; the shortfall still has to be made up. Charging interest from 15% gives a plausible,
legal-looking, wrong number, and nobody re-checks a tax computation that looks reasonable. The
months are fixed by the statute too — three, three, three, one — not counted from the delay
(`docs/71 §2`).

🔴 **A figure that is not yet owed must not be shown as a shortfall.** December's gap, in
October, in red, under the word "short", is docs/56 §2's frightening monthly hole in a new
place (`docs/71 §4`).

🔴 **A draft that moves across 1 April must move financial year with it.** `sendInvoice`
takes its number from the series for the invoice's `financialYearId`, so a draft edited to an
April date while keeping its old year would be numbered out of the previous year's series —
well-formed, from a real series, out of order, and invisible until somebody reconciles the
register (`docs/70 §3`).

🔴 **A form must not adopt a default on arrival.** The invoice form adopts the customer's usual
TDS section when a customer is picked; opening a draft sets the customer, which fired it and
silently replaced the section the draft was saved with. The guard is a ref consumed on the
first run, not a change to the dependency list, because the effect must still fire on a real
re-pick (`docs/70 §4`).

🔴 **A document's postings belong to the document.** A refund voucher's journal entry was
filed under `sourceType: 'RECEIPT'` and the ADVANCE's id, because `SourceType` had no member
of its own. So cancelling a refunded advance silently reversed the refund too — money back in
the bank, liability back in 2400 — while the voucher stayed live and stayed in GSTR-1 table
11B; and nothing could find a voucher's entry, which is why the cancellation `docs/65 §7` left
open was not merely unwritten but unwritable. A feature that cannot be built is usually a model
that is wrong somewhere else (`docs/69 §1`).

🔴 **An advance that has been refunded cannot be cancelled.** The voucher carries its own
number, went to the customer under rule 51 and is in the return. Cancel it first, then the
receipt — the only order in which both documents stay true (`docs/69 §2`).

🔴 **A refusal has to give its OWN reason.** A credit note is refused after filing because it
reached the customer's GSTR-2B; a refund voucher never does — table 11B adjusts the supplier's
own advances and has no counterpart on the recipient's side. Same shape of refusal, different
statute, and the wrong wording sends somebody to fix the wrong thing (`docs/69 §3`).

🔴 **A budget made of timings does not catch bytes.** `lucide-react` was imported as a
namespace and looked up by string, so every route shipped all 1,544 icons — 518 kB, in the
layout's chunk, for sixty-seven modules. FCP did not move by a millisecond, because the HTML is
server-rendered and paints before the JavaScript arrives. What it cost was `load` (2.45s against
1.55s on slow 4G), the battery and somebody's data. Only a static named import can be
tree-shaken, and `scripts/perf.mts` now has a bytes line docs/13 never had (`docs/68 §2`).

🔴 **An Undo in this system cannot be a reversal, so the gesture holds the action instead.**
Nothing is sent while the Undo is on screen; taking it means the thing never happened. Every
swipe that commits must be chosen so that LOSING the commit is safe — it may leave work undone,
never work half-done — because a tab that dies mid-window makes no request at all (`docs/68 §3`).

🔴 **The release of a drag must not read its distance from React state.** React batches within a
task, so a flick whose last move and release arrive together is judged on the offset from before
the drag, and the gesture silently does nothing. It only reproduces when the events are close
enough together to skip a render, which is rarely (`docs/68 §3`).

🔴 **Windowing a server-rendered list bounds the DOM, not the clock.** Halving the DOM of a
100-row list moved `domInteractive` by nothing; quartering the server-side `take` cut it by
1.26s. The rows are already in the RSC stream — the lever is the take, not the window
(`docs/68 §4`).

🔴 **A control in a column the mobile card drops is a control a phone cannot reach.** Two
corrections were reachable only from a desktop table column, and the receipt had no detail page
to fall back to. docs/49's gap at a different angle: not a service with no caller, but a caller
that exists only at one viewport width (`docs/68 §5`).

🔴 **A rule implemented inside one component applies only to that component's callers.**
"Tables become cards below 768px, never a horizontally scrolling grid" lives in `DataTable`;
six tables in five pages are not DataTable callers and had been scrolling sideways on a phone
since they were written. Measuring at 375px is what found them (`docs/68 §7`).

🔴 **In a money layout the label truncates, never the figure.** The first phone rendering of the
trial balance read `₹7,43,40…` (`docs/68 §7`).

🔴 **A page must not write in order to render.** `compare2b` reads; `reconcile2b` writes. The
same rules, in one place, so the chase screen and the portal screen cannot drift (`docs/62 §5`).

🔴 **The review marker must never reach a user.** It has escaped four times, most recently
into an email bound for a client. `tests/marker-leak.test.ts` strips comments from every
source and template file and asserts it does not survive (`docs/61 §3`).

🔴 **An employee is not a vendor.** s.206AA on salary is a FLOOR, not a flat rate, and salary
TDS is not a rate at all. A draft chase told four salaried people they were being deducted
20% "instead of 0%" (`docs/61 §2`).

🔴 **A reminder is computed at the moment of sending, never queued.** One prepared last night
about an invoice paid this morning is the message that teaches somebody to ignore all the
others (`docs/60 §2`).

🔴 **Cadence is the design, not the delivery.** Daily is how notifications get turned off; and
three messages at once about one overdue quarter is the same mistake in a morning
(`docs/60 §3`).

🔴 **Only a unique-constraint violation means "already sent".** A bare catch around the claim
turns a dropped connection into a silent duplicate, and the message never goes (`docs/60 §4`).

🔴 **A re-rendered document is not the document that was issued.** The template, the company's
own details, the logo and the signature are all read live. One invoice archived and rebuilt
seconds apart came out 433,850 bytes against 78,679, with the supplier block breaking
differently. Archive the bytes at issue and serve those (`docs/59 §1`).

🔴 **Archiving must never fail the thing it archives.** After the transaction, never inside
it; never throws; and what was not archived is named rather than hidden (`docs/59 §3`).

🔴 **A statement must say whether it can still change.** Closed, locked, or open — and a lock
that stops inside the period is a draft, not a lock. Every export before `docs/58` was silent,
and a year-to-date figure with nothing said is read as a final one (`docs/58 §1`).

🔴 **`period.to` is the financial year END, which for an open year is in the future.** A
balance sheet headed "as at 31 Mar 2027" was prepared in October. Clamping it also changes the
figures, because a payroll run is dated the 28th and the current month's salaries sit days
ahead of today — so the statement names what it stopped short of (`docs/58 §2`).

🔴 **`JournalLine` has no ordering column.** Order by `date, entryNo, id`: without the id the
two sides of an entry come back in an arbitrary order, so a running balance and an export an
auditor diffs are both irreproducible (`docs/58 §4`).

🔴 **A route that takes a `companyId` never gets the chance to ask who is reading.** Five API
routes had no authorisation check at all, and an EMPLOYEE could download every invoice. There
was no missing argument to notice, so only a grep finds it — `tests/route-authorisation.test.ts`
is that grep, and every new route must pass it (`docs/57 §1`).

🔴 **An unmatched identity means NO.** `payroll.own` resolves an employee by email; when the
lookup finds nothing the answer is refusal, never "therefore allow" (`docs/57 §2`).

🔴 **Two balances with the same name are not the same quantity.** Our credit ledger is credit
the books accrued; the portal's is credit a filed return claimed. Subtracting one from the
other reports a frightening hole every month that means nothing, and after three of those
nobody reads the screen again. Work out what the other side *should* be holding first —
`docs/56 §2`.

🔴 **Silence is not denial.** A challan absent from a statement that was never imported, or
that stops before the challan was paid, is *unchecked* — not missing. The first version of
`docs/56` told the owner that two challans paid last week had never been paid at all.

🔴 **A value bound twice in a template is substituted once.** Both renderers replaced the
first occurrence only, so the signature line kept the template's company name and the s.34(2)
declaration kept its placeholder invoice number. Use a global replace, and look for the
binding appearing more than once — `docs/48 §3`.

## 7. The largest remaining gaps

🔴 Rewritten on 04 Oct 2026, after module 68 — it drifts every time an item is struck off and
the numbering is edited rather than rewritten. If you strike one off, **rewrite this section**,
do not renumber it.

**Sixty-eight modules in, nothing module-sized is left.** The mobile tail was the last one, and
it is done: the gestures are wired, the budget is measured (`scripts/perf.mts`), and what
measuring it found is in `docs/68`. Everything below is a screen or a field. The next session's
job is no longer to find a class of gap, it is to close the remaining ones and then stop.

### A screen or a field each

- **Removing a user, and changing a role** — both are one field and the same guard, and
  neither has a screen (`docs/73 §7`)
- **ITR and GSTR-9 on the calendar read the current financial year**, so they show next
  year's dates rather than the ones falling due now (`docs/72 §2`). Worth fixing together with
  a way to mark them filed, which is what `docs/43 §5` has wanted all along
- **Opening balances as explicit entries** at year-end close (`docs/37 §7`)
- **IRN and QR on the invoice template** — the fields persist, the template ignores them
  (`docs/31 §7`)
- **Splitting account 1240** — only if a domestic s.9(3) reverse charge ever occurs, which has
  never been confirmed (`docs/63 §3`)
- **Server-side pagination** on the three 100-row lists — invoices, bills and receipts. The
  only remaining lever on how long a list page takes to become interactive, and nothing needs
  it yet: every route sits at roughly a quarter of its budget (`docs/68 §4`)

### Deliberate non-goals

- **S3 storage driver** (`docs/38 §7`) and the **live IRP client** (`docs/31 §6`) — both
  unimplemented on purpose, with the reasoning written down
- **E-way bills** — a goods mandate; Adpedia supplies services
- **Rule 86B** — below the threshold, and the exceptions want the CA (`docs/46 §7`)
- **Inoperative PANs** (rule 114AAA) — nothing available to this system can detect one
  (`docs/47 §7`)
- **Virus scanning** of uploads — files are never executed and never served inline (`docs/38 §8`)
- **`scripts/perf.mts` in CI** — it wants a production build, a running server and real data.
  Run it deliberately: before a release, and after anything that touches the app shell or adds
  a dependency to it (`docs/68 §1`)
