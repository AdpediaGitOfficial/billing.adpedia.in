# 83 · The phone could reach four screens, and the session ended at fifteen minutes

Two complaints, one shape: a thing that was built, looked finished, and had nothing
exercising it.

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
