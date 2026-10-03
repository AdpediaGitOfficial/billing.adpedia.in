# 60 · Nothing here ever told anyone anything

**Status: done.** 811 tests (363 unit + 448 integration), typecheck and lint clean,
production build passes.

The sender has existed since docs/30. So have the four payloads, the subscriptions, the
service worker and the permission flow. Exactly one of them has ever fired — payment
received, off a real receipt. The compliance calendar is read and never delivered; the
ageing report knows precisely which invoices are late and tells nobody; the PAN register
lists who has not sent their card and asks them nothing.

Opening the finished screen against the real books made the point better than any argument:
three deadlines, **63 to 70 days late**, that nothing had ever mentioned.

---

## 1. 🔴 The schedule lives outside; the decision lives here

A Next.js app has no scheduler. A `setInterval` in a module fires once per server process,
stops silently on a restart and runs four times behind a load balancer — so the timing lives
outside, in cron or launchd or a platform scheduler, and calls `/api/cron/notify` once a day.
What lives in the application is **what to send**, which is the part that needs the books.

🔴 That endpoint is the only route in the system with no signed-in user, so it carries its own
secret — and with `CRON_SECRET` unset it **refuses**. A scheduler endpoint that falls back to
"no auth configured, so allow" is one HTTP request away from anyone on the internet making
this company's phones buzz. The comparison is hashed on both sides before `timingSafeEqual`,
because that function throws on a length mismatch and the throw leaks the length.

The route-authorisation test from docs/57 caught this route the moment it was written, which
is what that test is for. It is exempt now, by name, with the reason — and a second test
asserts the exemption is earned: the file must mention `CRON_SECRET`, must refuse without it,
and must compare in constant time.

## 2. 🔴 Nothing is queued

Every message is computed at the moment of sending, from live data. A reminder prepared last
night about an invoice paid this morning is worse than no reminder: it is the one that
teaches somebody to ignore all the others. A test drives exactly that — chase due, receipt
recorded, chase gone, in the same run.

## 3. 🔴 How often, which is the whole design

| | |
|---|---|
| **Overdue invoice** | day 1, day 7, day 14, then monthly |
| **Compliance deadline** | a fortnight out, three days out, on the day — then weekly once late |
| **Bills awaiting approval** | once a day while any are waiting, as one message |

Daily is how a person turns notifications off, and then never hears the one that mattered. A
year of a single unpaid invoice produces **fewer than fifteen** messages rather than three
hundred and sixty-five, and a test asserts that rather than trusting the arithmetic.

### 🔴 And a crowd becomes one message

The first real run produced three separate pushes, one after another, about the same overdue
quarter — GSTR-3B, the GST payment, the TDS return. Three or more of a kind now collapse into
one line that names the first few. One or two stay individual, because each carries a link
worth following.

## 4. 🔴 Sent once, whatever runs the schedule

`NotificationLog` is keyed on **(kind, subject, day)** and the row is claimed *before* the
send. Two runs in the same minute — an overlapping cron, a restart, somebody curling the
endpoint to see what it does — produce one notification, because the unique constraint
decides it rather than a check-then-act that races itself.

🔴 And only a **unique-constraint violation** counts as "already sent". The first version
caught everything, which would have turned a dropped connection into a silent duplicate: the
message would never go, on exactly the days the database hiccuped, and nothing would say so.

A row is written even when it reaches **nobody**, because "no device has notifications on" is
a fact worth being able to see — and it is the first thing the screen says, since that is the
failure nobody discovers until an invoice is ninety days late.

## 5. The receipt that was quietly dropped

docs/30 §9 said receipt images were queued and never uploaded. That has not been true since
docs/38: the queue posts the photo separately, after the expense exists, and a test covers it.
**The gap list was stale** — worth saying, because a stale gap list is how real gaps hide.

The real defect was next to it. A photo the server *refused* returned "stop asking", the queue
item was deleted and the photo went with it: the expense stayed booked, nobody was told, and
after docs/59 that is precisely an input-credit claim with no evidence behind it. A refusal is
now kept as `failed` with the server's own words, and the offline bar says so in different
language from a queue that is merely waiting — *"3 expenses waiting to sync"* is reassuring
and true of one, and a lie about the other.

## 6. What is deliberately not here

- **Swipe gestures** (docs/30 §9). Still tap-only. They are polish next to a system that told
  nobody anything, and gesture work cannot be verified from here.
- **The performance budget** from docs/13 is still unmeasured.
- **Nothing emails.** Push reaches a phone that has opted in; a client chasing letter is a
  different thing and wants the customer's address, not a push subscription.
- **Quiet hours.** The cadence keeps the volume down; the time of day is whatever the
  scheduler is set to, which is the operator's decision rather than the app's.

## 7. Still open

- **Nothing chases the people outside the company.** The PAN register knows who owes a card
  and the certificate register knows who is owed a Form 16A; both still need a human to write
  the message. Internal reminders are the easy half.
- **The VAPID keys are development ones** in `.env` — production needs its own pair, and
  `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` must match the deployed domain exactly.
- **A per-user mute** does not exist: notifications are on or off per device, and somebody who
  wants only the overdue ones has to take all of them.
- Carried forward: service-item CRUD, note amendments (table 9C), refund vouchers,
  invoice-level GST reconciliation, the mobile tail's remaining two items.
