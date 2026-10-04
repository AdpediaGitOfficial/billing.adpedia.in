# 68 · The mobile tail, and the budget nobody had measured

**Status: done.** 920 tests (397 unit + 523 integration), typecheck and lint clean,
production build passes.

The last module-sized item in `docs/00 §7`: the swipe gestures docs/13 §4 specified and
docs/30 §9 left unwired, and the performance budget written in phase 0 and never once
measured.

Measuring it first was the right order, and not for the reason I expected. The budget was
being met. What measuring found was a route-level cost nothing in the budget was watching,
six pages breaking a rule docs/13 states in bold, and a users screen presenting ten
deactivated accounts as owners.

---

## 1. What the budget said, and what was true

> FCP < 1.5s on 4G · interactive < 3s · skeletons not spinners · virtualised lists past 50
> rows · route-level code splitting so an employee filing an expense never downloads the GL.
> — `docs/13 §4`

`scripts/perf.mts` walks all 38 list and grid pages on a cold first visit under Lighthouse's
slow-4G profile (1.6 Mbps, 150 ms RTT, 4× CPU) at 375×812, and reports FCP, `domInteractive`,
`load`, JavaScript bytes, DOM nodes, rows rendered, and anything scrolling sideways.

🔴 **It must be run against a production build.** `next dev` compiles on demand, ships a
hot-reload client and does not minify; a dev number is several times the real one and bears no
relation to it. Measuring the wrong thing is worse than not measuring, because somebody acts
on it.

🔴 **The server is local, so no hosting latency is in these figures.** The throttle shapes the
link, not the distance to the origin. What they measure honestly is the cost of the page
itself — the half the code controls, and the half that had regressed.

## 2. 🔴 1,544 icons on every route

`shell/icon.tsx` took an icon name as a string and looked it up:

```ts
import * as Icons from 'lucide-react'
const C = (Icons as Record<string, ComponentType>)[name] ?? Icons.Circle
```

A bundler cannot prove which member of a namespace a runtime string will reach, so it keeps
them all. Every app route loaded a **518 kB chunk containing all 1,544 lucide icons** —
`Tractor`, `AudioWaveform`, `GitPullRequestDraft` — against the 77 the app uses. It was in the
layout's chunk, so it was on the critical path of every page, and it had been there for
sixty-seven modules.

The fix is `shell/icons.ts`: a static named import into one object, with `IconName` derived
from it. Only a static import can be dropped, and deriving the type means a wrong name is a
typecheck error instead of a silently rendered circle — the eight call sites that took a bare
`string` are now typed.

| | before | after |
|---|---|---|
| First Load JS, every app route | 272–299 kB | 110–138 kB |
| JavaScript on a cold visit | ~1,050 kB | ~400 kB |
| `load` on slow 4G | ~2.45 s | ~1.55 s |
| **FCP** | **~690–790 ms** | **~650–810 ms** |

🔴 **The budget would never have caught this.** FCP did not move, because the HTML is
server-rendered and paints before the JavaScript arrives: a page can be two and a half times
too heavy and still pass a budget written in paint timings. What it costs is `load`, the
battery and somebody's data. `scripts/perf.mts` therefore carries a **bytes** line that
docs/13 does not — 550 kB a route, a little above where the app sits, so that another
library-sized mistake trips it and ordinary growth does not.

Guarded by `tests/mobile-reachable.test.ts`: no namespace import of lucide anywhere, no value
import of it outside the registry, and no icon in the registry that nothing uses — a registry
that only grows is the next 518 kB.

🔴 **Ask the question of the code, not of the prose.** Every one of those guards failed on its
own documentation first time out: the registry's comment quotes the namespace import it exists
to forbid. A guard that reports its own explanation is one somebody deletes.

## 3. Swipe, and what an Undo has to mean here

`docs/13 §4`: *swipe right = primary, left = secondary, always with Undo.*

The Undo is the hard part. **Nothing financial in this system is undoable** — rule 2 of
`docs/00 §3`: cancel and post a reversal, and both entries stay. An "undo" that posted a
compensating entry would leave two entries in the ledger and lie about it.

So the gesture holds the action instead of reversing it.

🔴 **Nothing is sent while the Undo is on screen.** A swipe *arms*; the row says what it is
about to do, a bar drains for five seconds, and the request only leaves the device when the
window closes. Taking the Undo means it never happened at all — verified against the ledger:
one bill left to commit came back `APPROVED` with one journal entry; one Undone came back
`DRAFT` with none.

🔴 **The failure direction is "nothing happened".** If the tab dies mid-window the request was
never made and the row is still on somebody's list. Every `commit` action has to be chosen so
that losing it is safe in exactly that way: it may leave work undone, never work half-done.
That is why a pending commit is also flushed when the page is hidden, and why a second swipe
settles the first rather than racing it.

🔴 **The Undo banner is in the present tense.** For those five seconds nothing has happened,
so "Approved" is a lie the person is being invited to accept — and if they take the Undo it
was never true at all. "Approving ADP/26-27/0031".

🔴 **And it cannot name what the action will produce.** A draft invoice has no number until
the send allocates one (`docs/64`), so the row says who it is going to. Peeking the next number
would print one another send may take first.

### What may be a gesture

| | | |
|---|---|---|
| `/invoices` draft | → Send | held behind the Undo |
| `/invoices` sent | → Receipt · ← PDF | links; `?invoice=` preselects and proposes the settlement |
| `/bills` draft | → Approve · ← Review | approve held behind the Undo |
| `/approvals` | → Approve · ← Review | the owner's mobile tab, so the screen it was for |
| `/expenses` | → The bill | a link |

🔴 **An action that needs words cannot be a gesture.** Cancelling anything requires a reason
(`docs/40`), and prompting for it inside the Undo window would mean the row said "cancelling"
before anybody had said why. Those swipes navigate to where the reason is asked for.

🔴 **A bill with no PAN is not offered the gesture.** s.206AA forces 20% and Form 16A cannot be
issued — a decision to be read about, not a thumb movement. The card says so and keeps the
button.

### Two things found by driving it

🔴 **The release must not read the drag distance from React state.** State is what the last
render saw, and React batches updates within a task: when the final `pointermove` and the
`pointerup` arrive together — a flick, a coalesced pair, a dropped frame — the release handler
sees the offset from *before* the drag, decides the gesture never passed the threshold, and
resets. Silently. It does not reproduce when the events are far enough apart to render in
between, which is most of the time. The live offset lives in a ref; `lib/swipe-gesture.ts`
takes it as an argument so the contract is in the signature, and is unit-tested without a DOM.

🔴 **A legend taken from the first row describes the first row.** The spec is decided per row,
so an invoice list whose newest entry happened to be a draft announced "swipe right to Send"
above a screen of sent invoices that do nothing of the kind. The legend is now the union: when
the rows disagree it stops naming the action and says only that there is one.

And two smaller ones: the panel is only as wide as the finger has pulled, so "Receipt" beside
an icon came out "Recei…" — icon over label, stacked. A gesture nobody knows about is not a
feature, so there is one line above the list, not a coach mark.

## 4. The window, and where the time actually goes

`Windowed` renders the first 50 rows and appends the next 50 when a sentinel comes into view;
`content-visibility` keeps what has scrolled past out of layout and paint. Measured on a
100-row expenses list:

| | DOM nodes | `domInteractive` |
|---|---|---|
| 100 rows, no window | 3,596 | 2,088 ms |
| 100 rows, windowed to 50 | 2,698 | 2,075 ms |
| 25 rows, server-side | 1,520 | **816 ms** |

🔴 **Halving the DOM changed the clock by nothing. Quartering the payload cut it by 1.26 s.**
Windowing a server-rendered list bounds the DOM, not the bytes: every row is already in the
RSC stream by the time the window runs, and the cost is the stream and its hydration. The
budget line says "virtualised lists past 50 rows" and the lever is the `take`. If a list in
this system ever grows past the 100 it caps at, the answer is server-side pagination — which
is what `/accounting/journal` already does at 50 a page — not a cleverer window.

The window stays: it bounds memory, and it is what makes a long list survivable on an old
phone. But it is documented for what it does rather than what the budget assumed it would do.

🔴 **The table is windowed for the phone's sake, not the desk's.** `DataTable` renders both the
table and the cards and hides one with CSS: a phone showing 50 cards was also parsing and
holding 100 table rows it can never see. `display: none` skips layout and paint, not the DOM.

## 5. 🔴 A control the mobile card drops is a control a phone cannot reach

`Column.mobile: false` hides a column on the card. Two of those columns held buttons:

- `/expenses` — the reverse control from `docs/49`, and the expense's own detail page did not
  offer it either, so on a phone a duplicate capture could be seen and never corrected
- `/receipts` — the cancel control, on a page with **no detail route at all**

This is `docs/49`'s gap at a different angle: not a service with no caller, but a caller that
exists only at one viewport width. `mobile: 'action'` is the slot, the reverse control is now
on the expense detail page too, and `tests/mobile-reachable.test.ts` fails on a column that
combines a control with `mobile: false`.

## 6. 🔴 The service worker was serving yesterday's code, by design

`sw.js` caches `/_next/static/` first, on the stated grounds that *"Next.js content-hashes
these, so a cached copy can never be the wrong version."*

True of a production build. False of `next dev`, which serves the same chunk at the same
stable path every time it recompiles. The worker then serves a stale chunk for ever, a UI
change looks like it did not take effect, and `rm -rf .next` does not help because the stale
copy is in the browser. It cost this session three wrong diagnoses in twenty minutes, and it
is in the handover (`docs/00 §5`) as a thing to remember rather than a thing that was fixed.

It is now registered **only in production**, and a dev page unregisters any worker an earlier
session left behind. The worker is still exercised the way it ships: `npm run build && npm start`.

`docs/63 §1` again — a caveat is a claim and has to be true. This one was a claim about
filenames that held in one environment and not the other, and nobody re-read it.

## 7. 🔴 Six tables scrolling sideways

> Tables become cards below 768px. **Never** a horizontally scrolling grid. — `docs/13 §4`

Measuring at 375px found six that do, across five pages:

| | |
|---|---|
| `/accounting/trial-balance` | 764px |
| `/reports/ageing` | 680px and 620px |
| `/settings/users` | 640px |
| `/payroll/runs` | 625px |
| `/tax/portal` | 403px |

None of them is a `DataTable` caller — the rule's implementation lives in `DataTable`, so it
never reached them, and nothing else was ever going to notice. Thirty-one files render a raw
`<table>`; most are narrow key/value lists that fit a phone, and these six were not.

`FigureCard` is the rendering for the ones `DataTable` cannot take: a trial balance row is an
account and six columns, not a record with one value, and squeezing it into one value slot
loses what the row is for. The figures wrap instead; the table stays for the desk.
`/settings/users`' capability matrix is a cross-tab, so on a phone it pivots — one card per
capability with the five roles down it.

🔴 **The label truncates; the figure never does.** First version had it the other way round and
the trial balance read `₹7,43,40…`. A number you cannot read is the one thing a ledger may not
print, and "Closing Dr" clipped to "Closing D" costs nothing.

🔴 **Sideways scrolling is now a budget failure**, checked on every route by `scripts/perf.mts`,
which is also why its route list is every page rather than a sample — the six it found were on
the pages a shortlist leaves out, because the pages anybody thinks to check are the ones that
were already right.

### And one thing the phone layout exposed

🔴 **A deactivated account read exactly like a live one.** `/settings/users` lists
`UserCompany` rows; deactivating a user sets `isActive` on the **User**, and the membership
survives. Ten accounts that cannot sign in were being presented, by the screen whose entire
subject is who can do what, as ten owners. It showed up because the dev database had collected
one preview account per session and the card layout put them one under another.

## 8. What this leaves

- **Server-side pagination** on the three 100-row lists (invoices, bills, receipts) is the
  only remaining lever on `domInteractive`, and nothing needs it yet: all 38 routes sit at
  580–850 ms FCP and 575–850 ms `domInteractive` against budgets of 1,500 and 3,000.
- **`scripts/perf.mts` is not in CI.** It needs a production build and a running server with
  real data; running it is a deliberate act, before a release or after anything that touches
  the shell.
- `docs/30 §9`'s remaining items are unchanged: receipt images stay on the device until an S3
  driver exists (`docs/38 §7`, a deliberate non-goal), and the VAPID keys and
  `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` are still development values that production must
  replace.
