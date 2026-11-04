# 83 · The phone could reach four screens, and the session ended at fifteen minutes

Two complaints, one shape: a thing that was built, looked finished, and had nothing
exercising it. §4 is a second pass at 375px with the fixes in — five more of the same thing,
found by reading the screen rather than the code. §5 takes the two calls §4 flagged and left,
and finds three more behind them; §6 is the numbering and the download that were asked for;
§7 is the month view. §8 is the development database this cost, and the guard that now stands
where there was none.

---

## 1. 🔴 Mobile navigation — a tab that led nowhere

`sidebar.tsx` is `hidden md:flex`. On a phone the **only** navigation is the five-slot tab
bar, and its fifth slot has always pointed at `/more`.

**There was no `/more` page.** It fell through to the roadmap catch-all —
`app/(app)/[...slug]/page.tsx`, docs/22 — which answered:

> Arriving in phase 1 · Partly live
> The data model, posting rules and guards for this area are already in place — what is
> missing is the screen.

…with two buttons back to the dashboard.

So a phone could reach **four screens out of sixty-five**: Dashboard, Invoices, Receipts and
Approvals. Projects, customers, vendors, bills, expenses, every report, every tax screen, all
of Settings and the drawings register were unreachable. Nothing failed. The bar rendered, the
link worked, and the page it reached returned 200 with a sentence explaining itself.

**`/more` is now the rail, as a list.** It calls `navFor` with the same two arguments the
sidebar is given, and that matters: 🔴 `navFor`'s `hasDrawings` **defaults to false**, so a
page calling it bare would have dropped the drawings register on every phone — and shown an
unregistered entity the GST screens docs/82 §4 refuses. A test asserts both arguments are
passed.

### The catch-all is gone

Of its eleven roadmap entries, ten now have real screens — and a real route always beats a
catch-all, so those entries had been dead for modules. The eleventh was `/more`. With `/more`
built, nothing could reach it at all.

🔴 **A roadmap stub standing in for a page that exists is worse than the 404 it replaced**: a
404 says "this is not here", which is true and checkable. "Arriving in phase 1" says the
product is incomplete, and it was wrong.

Removing it orphaned the `Construction` icon, which the icon-registry guard caught
immediately — docs/68 §2, working as intended.

### 🔴 Which books am I in, on a phone

The company name and logo live in the sidebar, and the sidebar is hidden on mobile. The mobile
header showed `/brand/adpedia-logo.svg`, hardcoded — **Adpedia's mark over entity B's books**.

docs/82 §3 says the current entity must be impossible to mistake, because an invoice raised in
the wrong one is numbered from that entity's series, posted to its ledger and frozen on send.
On the device most likely to be used in a hurry there was nothing to mistake it *by*. The
header now carries the entity's own name and logo.

### The guard

`tests/mobile-reachable` now asks the only question that would have caught this: **does the
target exist?** Every nav href, every mobile tab for every role, and the More tab's own href
must resolve to a `page.tsx`. It is checked against a made-up path so it cannot pass vacuously.

---

## 2. 🔴 The session — fifteen minutes, and a route with no caller

The complaint was five minutes. There were two separate things, and the five-minute one was
only the part that was visible.

### The lock screen

`IdleLock` locked after `5 * 60_000`, hardcoded. Five minutes is not idleness — it is reading
an invoice. It is a privacy screen drawn over a session that is still perfectly valid, and
what it achieved at five minutes was a passkey prompt in the middle of entering a bill; on a
device with no passkey registered, the only offer is *"sign in with password"*, which reads as
the session having expired.

Now `IDLE_LOCK_MINUTES`, **default 30**. 🔴 Read on the server and passed as a prop rather than
`NEXT_PUBLIC_` — that is inlined at build time (docs/90 §4) and could not be changed without
rebuilding. The copy on the lock screen derives from the same number, which it did not before:
it said "5 minutes" in its own sentence.

### 🔴 And behind it, a hard stop at fifteen

`/api/auth/refresh` was complete — rotating tokens, reuse detection, a thirty-day lifetime,
a `tokenVersion` check — and **nothing in the application ever called it.**

The access cookie is set with `maxAge: ACCESS_TOKEN_TTL_SECONDS`. Fifteen minutes after
signing in it expired, the middleware saw no token, and the user was redirected to `/login`,
mid-task, with nothing anywhere recording that anything had happened. docs/80's defect class
— working code with no caller — with the session as the thing it cost.

`SessionKeepalive` refreshes at **half the token's life**, so a refresh that fails once still
has a whole attempt before the cookie it renews disappears, and again on `visibilitychange`,
because a phone in a pocket runs no timers. 🔴 Only a **401** ends the session: a failed fetch
is a train tunnel, and this is a PWA expected to be offline (docs/30) — treating that as
"signed out" would discard the queued expenses it exists to protect.

### 🔴 And calling it from every tab would have been worse than the bug

Cookies are shared between tabs. Two tabs whose keepalive fires together both read the same
cookie and both present it. Two things went wrong, and the test found the second one:

| | |
|---|---|
| Reuse detection | one rotates, the other meets a row revoked milliseconds ago — the theft signal, which revokes **the whole family**. The keepalive that makes a long session possible would have been the thing that ended it |
| 🔴 A lost update | worse, and not what was being looked for. Both requests passed the `revokedAt` check and **both created a successor**: two live tokens in one family, one of them in nobody's cookie jar — a credential nothing would ever present and nothing would ever revoke. Reuse detection cannot see it, because nothing was reused |

So rotation now **claims the row**: `updateMany … WHERE revokedAt IS NULL` takes the row lock
first, the second transaction waits, re-evaluates, matches nothing and knows it lost. Exactly
one successor exists. The loser re-reads and gets `ROTATION_GRACE_MS` — 15 seconds — in which
a replaced token whose **successor is still live** is a race rather than a theft, and nothing
is revoked, because the winner's `Set-Cookie` has already put the new token in the jar they
share.

🔴 **The grace window spends none of the security property.** The row must have been replaced
inside the window *and* its replacement must still be live. A stolen token presented an hour
later, or one whose successor has since been revoked, still burns the family — both are
tested.

### The guard

A route that imports `@/server/auth/service` — the module that sets and clears the auth
cookies — must have a caller somewhere in `src/`. That is a rule rather than a list:
`/api/auth/me` only reads (a docs/20 diagnostic, no in-app caller), and the cron route is
called by cron. Removing `session-keepalive.tsx` makes it fail, naming `/api/auth/refresh`.

---

## 3. What this leaves

- **The idle lock is still not a security boundary**, and `idle-lock.tsx` still says so. It is
  drawn in the browser, over content already sent to the device.
- **`/api/auth/me` has no in-app caller.** Left alone deliberately: it reads, it cannot move a
  session, and docs/20 documents it as the "who am I" probe.
- **The mobile tab bar is still role-shaped and not entity-shaped** — `mobileTabsFor` takes
  only the role. Nothing on it is gated today, so nothing is wrong; if a `gstOnly` screen ever
  earns a tab slot, it will need the same two arguments `/more` now takes.

---

## 4. 🔴 A second look at 375px

Asked to check the phone again, so the app was walked at 375×812 — dashboard, `/more`,
invoices, the invoice form, the P&L, the compliance calendar, drawings, the entity switch —
on both entities. Navigation and the entity name were right. Five other things were not, and
none of them is visible from a desktop window.

*(The black circle over the Home tab in a dev screenshot is `<nextjs-portal>`, the Next.js dev
tools badge. Not ours.)*

### 4.1 The P&L said the opposite of what it meant

```
Net loss                                     −
                                  ₹9,55,000.00
```

`formatINR` returns `-₹9,55,000.00`. **A hyphen is a line-break opportunity**, and in a
narrow table cell the browser took it: the minus alone on one line, the number under it. On a
phone the bottom line of the profit and loss account read as a **profit** of nine lakh
fifty-five thousand, and the only thing saying otherwise was a stray dash floating above.

The sign is the most load-bearing character in the statement, and it was the one being
orphaned. `.tabular` — the class every money figure in the app already carries — now declares
`white-space: nowrap`. One line, sixty-three files' worth of figures.

### 4.2 Every field in the app zoomed the page

Mobile Safari zooms in whenever a focused form control is under 16px, and the viewport is
`initialScale: 1` with **no `maximumScale`** — deliberately, because disabling pinch-zoom is
an accessibility failure. `inputClass` was `text-[13.5px]`, used by 44 files.

So on the device docs/30 was written for, focusing any field threw the layout up a notch and
left the person to pinch back out — field after field, through an invoice. Nothing reports
it. The form works, it just fights. Now `text-[16px] md:text-[13.5px]`: the design's density
survives from `md` up, the phone gets the size that does not trigger the zoom.

### 4.3 Buttons that were only text had only the text's hit box

`+ Add line` on the invoice form was **20px tall** — a 13px label with no padding at all, and
the control pressed once per line item. A sweep found 24 more of the same shape at ~17px:
`back`, `remove`, `Undo`, `Reverse`, `Detach`, `It matches`, `Withdraw`. Apple's minimum is
44px and Android's 48; none of these reached half of it, and a mis-tap on `remove` undoes a
GST filing.

`tapTarget` — `inline-flex min-h-[44px] items-center md:min-h-0` — on all 25. The `md:` reset
keeps the dense desktop layout they were drawn for.

### 4.4 And the way back out of every page

`PageHeader`'s `back` link was 19px. That is the escape hatch the commit before this one
added to every detail page in the app, and on a phone it was the hardest thing on the screen
to hit. Same class, one place.

### 4.5 The mobile header's logo

§1 put the entity's own `logoUrl` in the mobile header beside its name. At the 20px square a
phone header can spare, a wordmark renders as an **illegible smudge** — and takes 28px from
the one thing that does identify the entity. Both of these entities begin with "A", so the
initial is decoration either way: the name is the identifier and it now gets the width. The
sidebar still shows the logo, where there is room for it to read.

### The guards

Three, each verified by neutering the fix:

1. **`.tabular` declares nowrap** — plus a non-vacuity check that `formatINR` still emits the
   hyphen the rule exists to suppress, and that every figure on the P&L is inside an element
   carrying the class.
2. **No form control sets a base font size under 16px** — `inputClass` itself, and a sweep of
   every hand-rolled `<input|select|textarea>` in `src/`. A `md:` or `sm:` prefixed size does
   not count, because it does not apply at phone width.
3. **A `<button>` whose className sets a font size and no padding must reference `tapTarget`**
   — plus the shared back link, by name.

🔴 **Guard 3 found nothing on its first run, and that was the bug.** It read
`<button\b([\s\S]*?)>`, and a non-greedy match stops at the *first* `>` — which in almost
every button here is the one inside `onClick={() => …}`. It never reached a single
`className`. It scans the tag now, tracking brace depth, and a non-vacuity test asserts the
scan reaches a real button's className. A guard that cannot see what it is guarding passes
forever.

### Left alone

- **`Button` is 38px tall on a phone** (`py-2` on a 13px label), and `sm` is ~31px. Under the
  44px guideline but not in the same class as 20px, and raising it moves every button in the
  app. A look-and-feel decision, not a defect — flagged, not taken. **Taken in §5.**
- **Stat cards stack one per row below 640px** (`sm:grid-cols-N` throughout). On `/invoices`
  that is four cards — a full screen — before the first invoice. Same kind of call.
  **Taken in §5.**
- **`/more` is a 3,488px scroll.** Correct as an index of everything; Settings is a long way
  down it.
- **The dashboard subtitle says "Billing, GST, TDS and cash" to an unregistered proprietor.**
  Cosmetic, but it is the docs/82 §5 shape: a screen mentioning GST to someone who has no
  GST.

---

## 5. 🔴 The two calls §4 did not take, and what taking them found

§4 flagged `Button`'s 38px and the one-per-row stat cards as look-and-feel, on the grounds
that each moves every page. That was the wrong line to draw. 38px is still under the minimum,
`Cancel invoice` and `Reverse` are both that one component, and "close enough" is not
something a thumb does. Both are one line in `kit.tsx`, which is the argument *for* changing
them, not against.

Taking them then turned up three things nothing had reported.

### 5.1 Every pressed control now clears 44px

The height is declared once — `tapMin` — and `tapTarget`, `Button` and `Segmented` all read
it, so the number cannot drift into a second copy. `Button` covers both sizes through its one
`base`, so `size="sm"` cannot wander away from `md`.

🔴 The header was outside all of it. The notification bell was **32px** and the account menu
**36px**, and neither is a `Button`, so §4's sweep went past them and the component fix did
not reach them. The bell is how you reach the alerts and the menu is how you sign out. The
header grows a few pixels on a phone and is untouched from `md` up.

### 5.2 🔴 A row of actions left the screen

Every action row in the app was `flex gap-2` with no wrap. A flex item whose content cannot
wrap has a min-content width of the entire row, so it cannot shrink either — the row simply
extends past the viewport. On the invoice at 375px the six buttons measured **634px in a
343px column**, and **`Amend`, the only way to correct a sent invoice, was the one furthest
outside it**, behind a horizontal scroll nothing announced.

Eleven rows, one class each: `flex flex-wrap gap-2`. `PageHeader`'s own action slot too. And
`Button` takes `whitespace-nowrap`, because once the row wraps a long label would otherwise
wrap instead and turn one 44px control into a four-line tower — which is what "The invoice as
issued" did, at 96px tall.

### 5.3 🔴 Two-up gave a long figure nowhere to go

Stat cards are two to a row on a phone now (`statGrid`), and the odd one out goes full width
rather than sitting half-empty. `/invoices` opens on the invoices again instead of on a screen
of summary.

Which exposed the next thing, and it was found by looking at the screen: `/invoices` printed
the next invoice number as `31/ADP/26-2` running out through the right-hand edge of its card
and off the display. Two cards to a row is a **134px** card; measured against Poppins in the
page, that value is **163px at 24px** — and `₹12,34,56,789.00` is 222px, so this was never
about numbering.

It cannot wrap, because §4 made `.tabular` `white-space: nowrap` — which is right, and is the
whole of 4.1. So the value scales instead, and the tiers are measured rather than guessed:
24px holds nine characters, 18px holds thirteen, 14px holds rule 46's longest legal sixteen.
None of it applies from `sm` up, where 24px was drawn to fit.

### 5.4 🔴 The same invoice rendered two different documents

Found while looking at something else. Twelve concurrent renders of ADP/26-27/0026 came back
as **two distinct files** — ten at 78 KB, two at 435 KB. Both were valid PDFs, both were set
in Poppins, and they broke their lines differently: the supplier block put GSTIN and PAN on
one line in one and on two in the other.

The template loads Poppins from `fonts.googleapis.com` with `display=swap`, and `setContent`
was awaited on `domcontentloaded`, which does not wait for an external stylesheet. So at the
moment `page.pdf()` ran, the `@font-face` rules might not be registered at all — there was
nothing for `document.fonts.ready` to be waiting on, it resolved immediately, and the page was
laid out in the fallback's metrics.

That is worse than a typography bug. docs/59 archives the bytes issued precisely so that *what
did you send* has one answer; a renderer whose output depends on a race answers it twice.

`awaitFont` waits, bounded, for the faces to be registered **and** loaded. Still never fatal —
the original reasoning holds, and a document must render even if Google is slow or blocked.
What changed is that it now waits long enough to be consistent when the font is reachable, and
🔴 **says so in the log when it is not**, instead of quietly issuing a differently-typeset
invoice. Six concurrent renders now give one document.

> **Still open.** The invoice template fetches its typeface over the network at render time,
> which contradicts the "self-contained, no network at render time" claim written beside the
> inlined logo and signature. On a box without outbound access every invoice renders in a
> fallback face, consistently, and differently from the archived copies. Vendoring Poppins
> into `templates/invoice/assets/` and inlining it the way the logo already is would close it
> — a ~350 KB decision about the repo, so it is flagged here rather than taken.

### 5.5 🔴 A failed archive was never written down

`archiveIssuedDocument` never throws, by design: an invoice that cannot be issued because a
PDF renderer is unwell is a worse failure than one with no file on record. It returns
`{ archived: false, reason }`.

🔴 **Three of the four callers discard the result.** `sendInvoice`, `issueCreditNote` and
`issueDebitNote` all `await` it and ignore what comes back — correct for the send, and it was
the whole of the reporting. So a failed archive produced an invoice issued with no copy on
file, a `reason` string built and thrown away, and **nothing in any log anywhere**. The screen
said a copy was missing (docs/59) and could not say why; the next click, *View document*, hit
the same failure behind the same generic sentence. Diagnosing it meant guessing.

docs/80's rule, arrived at from the other side: the message a person sees stays plain, and the
cause goes somewhere it can be read. `archiveIssuedDocument` is the only place that still knows
it, so it logs there — which document, which kind, and the error.

### The guards

- **the minimum is declared once** — `tapMin` is ≥44px, lifts at `md`, and `Button`,
  `Segmented` and `tapTarget` all read it; nothing else in the kit hard-codes a `min-h`.
- **no row of buttons is a non-wrapping flex row**, and `PageHeader`'s slot wraps.
- **every stat row uses `statGrid`**, which is two columns and carries no `sm:`/`lg:` of its
  own — those belong to the page.
- **`valueSize` scales by length and restores 24px from `sm` up**, and `StatCard` renders
  what it returns.
- **six concurrent renders produce one document** (integration — it is the only form in which
  the race is visible).
- **a failed archive logs which document and why**, asserted by capturing `console.error`.

Each was checked by neutering its fix and watching it fail with the right message.

---

## 6. 🔴 The numbering, and the file

Two asks, and the first turned out to be a field nothing could write.

### 6.1 🔴 `DocumentSeries.pattern` was stored, checked, printed — and unsettable

Adpedia numbers its invoices `30/ADP/26-27`, not `ADP/26-27/0030`. The system already held
the format as data: `DocumentSeries.pattern`, rendered by `renderPattern`, validated against
rule 46 by `validateInvoiceNumber`, and printed on **Settings → Document series** beside the
next number it would produce.

🔴 **Nothing in the application could set it.** docs/67 §2's class exactly — a field nothing
binds. The shape of every number this company issues was decided by the seed script, and
changing it meant a hand-written `UPDATE`. The page that displayed it was read-only.

It is now a form on that page, per series, with the next number previewed live from the
sequence the series is actually on — derived from the field being typed, not from what is
saved, for the same reason the ROC form derives its deadlines that way (docs/72): the one
thing you need while editing a pattern is the string it will print, and rendering the stored
one shows you the format you are trying to leave.

**Two placeholders are required rather than offered**, and neither is a style rule:

- **`{SEQ}`** — without it every document in the year renders the same string, and the second
  send fails on `@@unique([companyId, number])` at the end of a transaction that has already
  posted a ledger entry.
- **`{FY}`** — that index is unique per **company**, not per financial year, and the sequence
  restarts each April. Without the year, invoice 1 of 2027-28 collides with invoice 1 of
  2026-27 — and it surfaces on the first invoice of a new year, which is the worst possible
  moment to find out.

🔴 **The sequence is not touched.** Rule 46(b) wants the run consecutive, and the run is the
sequence, not the string it is printed into: 26, 27, 28 stays 26, 27, 28 whether it reads
`ADP/26-27/0028` or `28/ADP/26-27`. Moving `nextSeq` is a different act with different
consequences — it either repeats a number already issued or leaves a hole the register reports
as unexplained — and it is not what changing a format means. Documents already issued keep the
number they went out with.

🔴 **The new pattern is checked at its widest**, at sequence 9999, the same rule the register
applies: a pattern that fits at 30 and breaches sixteen characters in October would otherwise
be accepted now and block issuing then. The change is audited, because it changes what every
future document is called.

### 6.2 🔴 And the new pattern immediately broke the archived filename

The first invoice issued as `30/ADP/26-27` was archived as **`26-27.pdf`**.

`safeLabel`, in the attachment store, strips anything that could matter if the name were read
as a path — including everything before the last `/`. It is a path-traversal guard and it
cannot tell a directory from an invoice number. Under `ADP/{FY}/{SEQ:4}` it had been quietly
storing `0029.pdf`: lossy, survivable. Under `{SEQ}/ADP/{FY}` the same guard produced the
string **every invoice in the year would be called**.

`pdfFilename` already existed and already did the right thing — slashes to dashes. The three
archive callers were interpolating the raw number instead. They go through it now, so the
whole number survives the guard.

### 6.3 The file, as a file

`?download=1` on the document route sends `attachment` instead of `inline`, and the invoice
carries a **PDF** button beside *View document*.

`inline` was deliberate and stays the default: tapping an invoice on a phone should open a
preview, not drop something into Downloads that you then have to go and find. What was missing
was the other half. Looking at a document and wanting the file are two different intentions,
and only one of them could be expressed.

### 6.4 🔴 And a label that was never a label

`seriesLabel` fell back to `?? d`, and `REFUND_VOUCHER` had no entry — so that series was
headed **`REFUND_VOUCHER`** on the settings page, from the moment docs/65 added it. Found by
reading the page the pattern form went onto. The map was `Partial`, which is what allowed it
to be quietly incomplete; it is total now, so the next `DocType` added will not compile until
somebody gives it a name a person can read.

### The guards

- **a pattern takes the sequence wherever the business puts it**, and is refused without
  `{SEQ}` or `{FY}`, with an unknown placeholder, or with anything outside rule 46(b)'s
  alphabet around them.
- **changing the pattern does not move the sequence**, leaves no unexplained gap, and leaves
  every number already issued byte-identical.
- **a pattern that breaches rule 46 at 9999 is refused**, and nothing changes.
- **the change is written to the audit log.**
- **the archived copy is filed under the whole number, whatever the pattern** — asserted
  against `26-27.pdf` by name.

### Left open

- **The seed still writes `ADP/{FY}/{SEQ:4}`.** The integration tests assert against it, and
  a fresh install should get a conventional default. A `db:reset` therefore puts the old
  format back, and Settings → Document series is where to change it again.
- **The examples given were 18, 20, 21, 22** — skipping 19. If that is the real historical
  run rather than shorthand, 19 is a hole in a GST series and the register will say so; it
  needs a reason, not a renumbering. Nothing here moved the sequence.
- **`?download=1` is on the invoice route only.** Credit notes, debit notes, payslips and
  vouchers still serve `inline` with no way to ask for the file.

---

## 7. 🔴 Month by month

The invoice list could be read one invoice at a time and the tiles above it one financial
year at a time, and there was nothing in between. *What did we bill in July* meant paging
through a list ordered by date and adding it up by eye; *is anything missing from August*
could not be asked at all.

It is the GST view as much as the admin one. GSTR-1 is filed per month — per quarter under
QRMP, docs/23 — so the month is the period the return is **about**, and a month whose total
here does not match the return filed for it is the first thing to look at.

`/invoices?view=months` is the year, and clicking a month is `/invoices?month=2026-11`, which
filters the list. Two links rather than a `Segmented`, because this is navigation: it has to
survive a bookmark, a share and the back button, which a piece of client state does not.

### What the month rows will not do

- 🔴 **A cancelled invoice is counted and not added up.** It keeps its number (docs/41) and it
  has been reversed, so including its value overstates what the month billed. Dropping the row
  entirely would hide that something was raised and withdrawn, which is what an assessment
  asks about — so the count sits beside the money, not inside it. Drafts likewise: a draft has
  taken no number and posted nothing.
- 🔴 **An invoice that is not in rupees is named, not converted.** `Invoice.fxRate` is in the
  schema and is read **nowhere** in the application — docs/67 §2's class again — so it is 1 on
  every row including the exports. A USD grand total added into a rupee column at a rate of 1
  is wrong by two orders of magnitude and looks like a number. The rupee columns are rupees,
  and `+ 1 in USD` says the rest.
- 🔴 **Every month of the year is listed, including the empty ones.** A list that skips July
  answers "what did we bill in July" with silence, and silence reads the same as not having
  looked. docs/64's argument in a new place: a gap has to be visible before anyone can explain
  it.

### 🔴 And the figure that did not agree with the one beside it

The first version computed a month's outstanding as grandTotal − received − TDS credited, and
the twelve months then added up to **₹5,000 more** than the Collectible tile on the same
screen. The missing term is the TDS the customer has not yet deducted: a ₹59,000 invoice on
which ₹5,000 will be withheld is settled by ₹54,000, so counting the ₹5,000 as outstanding
makes a paid month look permanently short (docs/02 §B1). Two figures that both read as *what
is owed*, differing — docs/56 §2's "two balances with the same name". The integration test
asserts the months sum to `arSummary.total`, which is what caught it.

The receivables tiles are left out of the month view entirely and labelled *whole year* on a
filtered list, because they answer a receivables question and the month table answers a
billing one.

### The guards

- **`monthBounds` refuses anything that is not a real month** — `2026-13`, `2026-1`, a date,
  an injected string — and the range is half-open, so the last day of the month is inside it
  and the 1st of the next is not.
- **twelve months, April first and March last, including the empty ones.**
- **an invoice lands in its own month** and does not spill across a boundary (the 1st and the
  31st are both asserted).
- **a cancelled invoice is counted and contributes nothing**; so is a draft.
- **the months sum to the company position shown beside them.**
- **a non-rupee invoice is named and adds nothing to the rupee columns.**

---

## 8. 🔴 What this cost: the development database

While adding §7's tests I ran one integration file the obvious way —
`npx vitest run tests/invoice-months.integration.test.ts` — instead of `npm run test:db`.

`npm run test:db` sets `DATABASE_URL` to `adpedia_test` on the command line. Run vitest
directly and **Vite loads `.env` into `process.env` itself**, so `DATABASE_URL` is the
development database. `resetDb` TRUNCATEs every table in the schema and reseeds, and it never
checked which database it was pointed at.

🔴 **The first sign was the test suite going green.** A truncated and reseeded database is
exactly what an integration test asks for, so nothing failed and nothing warned. What was lost:

- **AKASH — FREELANCE**, the second entity, created through Settings → Companies in docs/82
  and present in no seed or script. It has to be entered again, and its PAN is deliberately
  not in this repository.
- **Both real user accounts**, and every document raised in the dev database by hand.
- The `{SEQ}/ADP/{FY}` series pattern, which reverted to the seed's default.

What was recoverable, and has been: `prisma/seed` is idempotent, so `npm run db:seed` restored
entity A's profile, chart of accounts, financial years, series, bank, rates and the real owner
login without destroying anything further. The series pattern is set again. The test seed's
`test@adpedia.local` — an OWNER account whose password is `test` — was left behind by the
truncation and is deactivated.

### The guard

`resetDb` now calls `assertTestDatabase` and **throws unless the database name ends in
`_test`**. The exact command that caused this refuses:

```
Error: resetDb refuses to truncate "adpedia" — it is not a test database.
```

A convention that has to be remembered is not a guard. The name is the only thing that
distinguishes the two databases, so the name is a precondition, checked before the first
`TRUNCATE` rather than explained afterwards. Its own test covers the development name, the
test name, a name past a query string, a query string that merely contains the word, an unset
variable, and the live call path where the environment is what decides.
