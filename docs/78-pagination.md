# 78 · Server-side pagination

**Status: done.** 1,023 tests (419 unit + 604 integration), typecheck and lint clean,
production build passes.

`docs/68 §4` measured which lever actually moves a list page: windowing the DOM of a 100-row
list moved `domInteractive` by **13 ms**, and quartering what the *server* sends cut it by
**1.26 s**. This pulls that lever on the three lists that took 100 rows — invoices, bills and
receipts — and puts the journal, which already paginated, on the same arithmetic.

Measured again here, on 140 invoices, slow 4G, CPU ×4:

| | rows sent | `domInteractive` | `load` |
|---|---|---|---|
| the whole list | 140 | 2,182 ms | 2,185 ms |
| one page | 50 | **1,484 ms** | **1,781 ms** |

The DOM barely moved (2,887 → 2,623 nodes) because `docs/68`'s window already capped the cards
at fifty. The saving is the payload, exactly as that module predicted.

---

## 1. 🔴 A paginated list needs a *total* order

`/invoices` ordered by `date desc, seq desc`. **Every draft carries `seq: 0`.** Fifty drafts on
one date therefore had no order between them at all, and a database is free to return equal rows
in a different order for page 1 than for page 2 — the same invoice twice, another one never.

`/bills` ordered by `billDate desc` alone, and `/receipts` by `date desc` alone: no tiebreak at
all, on columns that repeat constantly.

Unpaginated this only looked untidy. Paginated it **loses rows, and nothing says so** — the
count at the bottom still reads 140, every page looks full, and the invoice that vanished is
only noticed by whoever was looking for it.

`id` is now the last term on all three. It is `docs/58 §4`'s lesson in a new place: *`JournalLine`
has no ordering column — order by `date, entryNo, id`, because without the id a running balance
and an export an auditor diffs are both irreproducible.*

The journal was already safe: `entryNo` is unique per company per financial year.

## 2. 🔴 A figure computed from the page is a figure about the page

Three of them, each correct right up until the list stopped being everything:

- **`/receipts`** summed `live.reduce(...)` over the rows on screen. Paginated, "Collected"
  becomes *collected on this page*, and the tile changes every time somebody presses Next.
  It aggregates in the database now.
- **`/bills`** counted reverse charges with `bills.filter((b) => b.isRcm).length`.
- **`/receipts`** built the list of invoices an advance could be adjusted against from
  `receipts.filter(isAdvance)` — every advance, while the array was every receipt. Paginated, an
  advance on page 2 would have opened an "adjust" control onto an empty list, for no visible
  reason. It reads the customers of every *open* advance instead, which is what it always meant.

A tile that changes when you page is the fastest way to make a screen untrustworthy — `docs/56
§2`'s lesson about a figure nobody can explain, arrived at from the other direction.

## 3. 🔴 Out of range is clamped, never empty

`?page=99` on a three-page list is a stale link, a bookmark, or somebody who cancelled enough
rows to shorten it. Returning nothing renders the empty state — *"No invoices yet"* over a
company with a hundred and forty of them — which reads as data loss.

`paginate()` clamps to the last page. A total of zero is **one** page, so "Page 1 of 0" cannot
be printed, and nonsense (`abc`, `-4`, `1.9`) lands on page 1.

## 4. One pager, not four

`lib/paging.ts` is pure and unit-tested, because every off-by-one in a paginated list is in
there and none of it needs a database. `components/ui/pager.tsx` renders it.

- **"101–140 of 140 invoices"**, not "Page 3 of 3". It answers the question somebody actually
  has — whether what they are looking for is behind them or ahead.
- **Nothing at all for a single page.** A pager over eleven invoices is noise that teaches
  people to stop looking at the bottom of a list.
- 🔴 **A disabled step is not a link.** Rendering one that goes nowhere is a control lying about
  being usable, and on a phone it is a 44-pixel target that does nothing.

## 5. Still open

- **No page size control, and no deep-link to a row.** Fifty is fifty; somebody looking for an
  invoice from March pages back to it. Search would be the better answer than either.
- **Offset pagination**, not keyset. At these volumes `OFFSET 100` costs nothing; at a hundred
  thousand rows it would, and the fix then is to seek on the sort key rather than to skip.
- Carried forward from `docs/00 §7`: splitting account 1240, if a domestic s.9(3) reverse charge
  is ever confirmed.
