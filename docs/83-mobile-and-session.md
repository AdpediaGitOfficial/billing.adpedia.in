# 83 · The phone could reach four screens, and the session ended at fifteen minutes

Two complaints, one shape: a thing that was built, looked finished, and had nothing
exercising it. §4 is a second pass at 375px with the fixes in — five more of the same thing,
found by reading the screen rather than the code.

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
  app. A look-and-feel decision, not a defect — flagged, not taken.
- **Stat cards stack one per row below 640px** (`sm:grid-cols-N` throughout). On `/invoices`
  that is four cards — a full screen — before the first invoice. Same kind of call.
- **`/more` is a 3,488px scroll.** Correct as an index of everything; Settings is a long way
  down it.
- **The dashboard subtitle says "Billing, GST, TDS and cash" to an unregistered proprietor.**
  Cosmetic, but it is the docs/82 §5 shape: a screen mentioning GST to someone who has no
  GST.
