# 30 · Phase 9 — Mobile, offline and the device layer

**Status: done.** Typecheck and lint clean, **311 tests** (167 unit + 144 integration).

Everything up to here assumed a desk and a connection. This phase is about the expense
filed in a basement car park, the invoice sent over WhatsApp, and the phone left face-up
on a table.

---

## 1. 🔴 The queue cannot be allowed to book an expense twice

This is the one thing in the phase that can corrupt the books, so it was built first.

An offline queue retries anything it did not get a response for. **"No response" includes
the case where the server committed and the network died on the way back.** Retry that
naively and one taxi fare becomes two expenses — and, far worse, its input credit is
claimed twice on the GST return, which is the part nobody notices for three months.

The fix is a `clientKey` generated **on the device, before the first attempt**, stored
`@@unique([companyId, clientKey])`, and replayed unchanged on every retry:

```ts
if (input.clientKey) {
  const existing = await prisma.expense.findUnique({
    where: { companyId_clientKey: { companyId: ctx.companyId, clientKey: input.clientKey } },
  })
  if (existing) return existing      // the replay is a no-op, not a second expense
}
```

The key is `crypto.randomUUID()`, never a timestamp — two expenses filed in the same
millisecond on the same phone would collide, and a collision here means one is **silently
discarded as a duplicate**.

Tested from both ends: the client always re-sends the same key after a failure, and the
server returns the first expense with no second journal entry. Verified over real HTTP too
— the same `id` comes back twice.

### What the queue does with a refusal

A `4xx` other than 408/429 means the server read the request and refused it — a missing
category, a closed period. Retrying cannot fix that, and a queue that spins on it never
drains. Those are parked as `failed` and surfaced for the person to fix, not dropped.

## 2. 🔴 What the service worker deliberately does not cache

**No page HTML. No API response. No report. No balance.**

Every one of those is account-scoped financial data, and a cache is shared across whoever
uses the device. A cached `/dashboard` would show one user another's figures after a
logout; a cached balance would present a stale number as current — which in a ledger is
worse than an error page, because it looks right.

So the cache holds exactly two things: content-hashed build output, identical for
everyone, and an offline page that says plainly that it is offline and lists what still
works. The IndexedDB expense queue is what actually makes the app useful without a
network; the service worker just stops the shell failing to load.

## 3. Reading a receipt

`extract.ts` is a pure function over OCR text, under test; `ocr.ts` lazily imports the
engine. The split matters: the parsing rules are the valuable part and they are small and
checkable, while the engine is several megabytes of WASM that should only download when
someone actually photographs something.

Two rules that are specifically Indian, and both were found by tests failing:

- **🔴 CGST and SGST are two halves of one tax and sit on separate lines — they must be
  added.** Taking either alone halves the tax, the receipt then fails its own add-up
  check, and *both* figures get discarded.
- **🔴 Dates are day-first.** `01/10/2026` is 1 October. Read the American way it becomes
  10 January — a different quarter, so the expense lands in the wrong GST return and the
  credit is claimed late.

Everything extracted is a **suggestion**. The form pre-fills and the person confirms; OCR
on a crumpled thermal receipt is wrong often enough that auto-submitting would be worse
than typing. When the parts do not add up the weak fields are dropped rather than
pre-filled, because a confidently wrong number gets accepted without a second look. Every
amount found is offered as a one-tap correction.

## 4. Biometric re-auth

WebAuthn via `@simplewebauthn`, not hand-rolled — a home-made signature check would be
security theatre, which is worse than none.

- Challenges are **server-generated, single-use** and taken-and-deleted in one step.
- `userVerification: 'required'` — the point is proving a *person* is present, not that a
  device is unlocked.
- The credential must belong to **this session's user**, or anyone with a valid passkey
  could unlock anyone's idle session.
- A **non-zero** signature counter that fails to advance means the credential was cloned
  and the assertion is refused. Authenticators that report `0` throughout are legitimate,
  so only a counter that was previously non-zero is treated this way.

🔴 **The lock screen is a privacy screen, not a security boundary.** It is drawn in the
browser, so anything it covers has already reached the device. What it buys is the real
case: a phone left on a desk, or handed over to show someone a photo. The actual boundary
is the session cookie and the server's role checks — written in the component so nobody
later skips a permission check because "the lock screen covers it". A passkey never
creates a session and never replaces the password.

## 5. Push

Four events, per the spec: payment received, approval pending, GST/TDS due, invoice
overdue.

🔴 **A notification carries the event, never a figure that should be read in context.**
Push payloads land on a lock screen in front of whoever is holding the phone, and they
pass through a third-party push service on the way. "Payment received from Click AR" is
fine; the company's cash position is not.

Sending is fired **outside** the receipt transaction and not awaited into the result: a
push service being slow must never roll back a receipt that is already posted. The money
arrived whether or not anyone's phone buzzed. A `404`/`410` from a push service means the
subscription is permanently gone, so that row is marked failed instead of being retried on
every later send.

## 6. Share

Web Share API with the actual PDF file, which is how invoices really get sent here — no
link that expires, no login wall for the client. Falls back to sharing the URL, then to a
plain download. A dismissed share sheet throws `AbortError`; that is a person changing
their mind, not an error, and is not reported as one.

## 7. Dashboard in one round trip

`/api/dashboard`. On a phone the cost is latency, not the database: eight requests over
patchy 4G is eight chances to stall. `dashboardSummary` already batched its queries, so
this endpoint exists purely to collapse the network side.

🔴 Decimals serialise as **strings**. Sending `1234.56` as a JSON number makes it a float,
and a float is how a rupee goes missing — exactly what `lib/money.ts` prevents everywhere
else.

## 8. What this phase found

**🔴 The service worker was unreachable.** The auth middleware matcher excluded `api`,
`_next`, `brand` and the manifest — but not `/sw.js` or `/offline.html`. The browser
fetches the service worker itself, outside any page, so it was being redirected to
`/login`: registration failed silently, taking the entire offline queue down with it.
Caught by requesting the routes rather than trusting the build, and the fix is in the
matcher with a comment saying why.

## 9. Still open

- **Receipt images are held in the queue but not yet uploaded** — the expense syncs, the
  photo stays on the device until S3 storage is wired.
- **Swipe gestures** (right = primary, left = secondary, with Undo) are still not wired;
  the card UIs work by tap.
- **Push is not yet scheduled** — the sender and all four messages exist and payment-received
  fires on a real receipt, but due-date and overdue notifications need a cron job.
- **VAPID keys are development ones** in `.env`; production needs its own pair, and
  `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` must match the deployed domain exactly or every
  assertion fails.
- Performance budget from docs/13 (FCP < 1.5s on 4G, virtualised lists past 50 rows) is
  **not yet measured**.
