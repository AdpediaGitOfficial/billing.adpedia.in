# 22 · Design System

Built from four fintech dashboard references (Finexa, Paynix, ACRu, COINEST), with the
colour decided by the **dataviz method** rather than by eye.

---

## 1. What was taken from the references, and what was not

**Taken** — the structural vocabulary that makes those screens read as enterprise:

| Pattern | Where it lands |
|---|---|
| Grouped, labelled sidebar with a filled active pill and a collapse control | `components/shell/sidebar.tsx` |
| Topbar: search, FY context, notification badge, avatar menu | `components/shell/topbar.tsx` |
| KPI row — eyebrow label, large tabular figure, tinted icon tile, delta chip | `StatCard` |
| Hero number with a progress bar beneath | `HeroStat` + `ProgressBar` |
| Card with title / subtitle / right-hand action | `Card` + `CardHeader` |
| Status pills with a leading dot | `Pill` |
| Area chart with gradient fill, crosshair and tooltip | `charts/area-chart.tsx` |
| Ranked horizontal category bars | `charts/category-bars.tsx` |
| Light tables with an eyebrow header row and right-aligned money | `DataTable` |

**Not taken:**

- **A colour per category bar.** Finexa paints each spending category a different hue.
  Bar length already encodes rank, so a hue per row is colour-by-rank — it carries no
  meaning and repaints when a filter changes the row set. `CategoryBars` uses **one
  sequential hue** that darkens with share, with every bar directly labelled.
- **The donut.** Two of the references use one for expense breakdown. A ranked bar list
  is easier to read, compares better, and survives more than four slices.
- **Decorative card art.** A credit-card graphic is fine in a consumer app; in an
  accounting system the space is better spent on the ageing buckets.
- **Invented numbers.** Every figure on the dashboard comes from the database. With one
  invoice in the system the charts are nearly empty, and they say so rather than
  showing a plausible-looking curve.

---

## 2. Colour — computed, not chosen

Adpedia's brand is `#4135AF`. Run through the validator it sits at **OKLCH L 0.425**,
outside the categorical lightness band (0.43–0.77) — so the brand itself is used for
**chrome** (buttons, active nav, focus rings) and never as a data mark. The series slot
is a lighter step of the same hue.

### Categorical — fixed order, never cycled

| Slot | Light | Dark | Used for |
|---|---|---|---|
| 1 | `#5A4BD4` | `#8B7BF0` | invoiced revenue |
| 2 | `#eb6834` | `#d95926` | — |
| 3 | `#1baf7a` | `#199e70` | cash received |
| 4 | `#eda100` | `#c98500` | — |

```
LIGHT  worst adjacent CVD ΔE 9.1 (protan) · normal-vision ΔE 22.9    PASS
DARK   worst adjacent CVD ΔE 8.4 (protan) · normal-vision ΔE 19.8    PASS
```

Order matters: yellow must never sit adjacent to orange — that pair fails the
normal-vision floor at ΔE 13.7. Slot 2 and slot 4 are therefore separated by aqua.

The light-mode contrast check WARNs on aqua and yellow (below 3:1 on white). The relief
rule applies and is satisfied: every chart ships **direct labels and a table view**.

### Sequential — one hue

`--seq-100 → --seq-700`, an indigo ramp. Used for magnitude lists where length already
carries the comparison.

### Status — reserved

`--good` `--warn` `--critical` `--info`, each with a soft background. **Never reused as a
series colour**, and always paired with an icon or a label rather than carrying meaning
by colour alone.

### Reproducing the check

```bash
node validate_palette.js "#5A4BD4,#eb6834,#1baf7a,#eda100" --mode light --surface "#ffffff"
node validate_palette.js "#8B7BF0,#d95926,#199e70,#c98500" --mode dark  --surface "#15141c"
```

---

## 3. Tokens

Three surface levels so cards read above the page without shadow spam:
`--app-bg` → `--surface-1` (cards) → `--surface-2` (table headers) → `--surface-3` (tracks).

Ink is `--text-primary` / `--text-secondary` / `--text-muted`. **Text always wears a text
token, never a series colour** — a coloured dot beside the label carries identity instead.

Dark mode is *selected*, not an inverted flip: its own steps from the same ramps,
validated against the dark surface. Declared under both `@media (prefers-color-scheme: dark)`
(guarded with `:not([data-theme="light"])`) and `:root[data-theme="dark"]`, so a future
theme toggle wins both ways.

---

## 4. Charts

Four primitives, inline SVG, **no chart library**:

| | |
|---|---|
| `AreaChart` | change over time · 2px strokes, gradient fill, crosshair + tooltip, legend, table view |
| `BarPair` | two measures across periods · 4px rounded tops, 2px gap, per-group tooltip |
| `CategoryBars` | ranked magnitude · one hue, direct labels |
| `Sparkline` | trend inside a stat tile · no axes, no tooltip |

Rules held throughout: **one y-axis, never two**; recessive grid; a legend whenever there
is more than one series; no number on every point.

### One RSC constraint worth recording

Charts are client components rendered from server components, so a `formatValue` function
**cannot** be passed as a prop — functions are not serialisable across the boundary, and
Next fails at render with *"Functions cannot be passed directly to Client Components"*.
Charts take a `format` token (`'inr' | 'inr-compact' | 'inr-whole' | 'number'`) and
resolve it on the client.

---

## 5. Responsive

`DataTable` takes one column definition and renders **a table on desktop, cards below
768px** — each column declares its mobile role (`primary` / `secondary` / `value` /
`tag` / `false`). A horizontally scrolling grid on a phone is never an option.

The sidebar is desktop-only; mobile uses the role-shaped bottom tab bar from `docs/13` §2.3.

---

## 6. No dead links

Every nav entry resolves. Sections that belong to a later phase render a roadmap page
naming the phase and what lands in it, rather than a 404 — `app/(app)/[...slug]/page.tsx`.
**Removed in docs/83.** Every route it covered has a real screen now, so the only path it
still answered was `/more` — the mobile tab bar's fifth slot — which it told the user was
“arriving in phase 1”. A roadmap stub standing in for a page that exists is worse than the
404 it replaced: it reads as an answer.

---

## 7. Honest empty states

With one invoice in the database, most of the dashboard is genuinely empty. Each empty
state says what will fill it:

> **No postings yet** — the chart fills in as invoices are sent and receipts recorded.
> Nothing here is sample data.

An accounting dashboard full of convincing fake numbers is worse than a blank one.
