# 21 · Phase 1 — Sales

**Status: done.** The §6 deferral was completed later — see [33-pdf-worker.md](33-pdf-worker.md).
Typecheck clean · lint clean · production build passes · **104 tests** (72 unit + 32 integration).

The first real invoice exists in the dev database: **`ADP/26-27/0026`**, ₹1,00,300,
TDS ₹8,500 u/s 194J, net ₹91,800, settled by a receipt.

---

## 1. The tax engine

`src/server/services/tax/`

**Mode is derived, never chosen** — `resolveTaxMode(company, customer)`:

| Customer | Mode | Tax |
|---|---|---|
| Kerala | `INTRA` | CGST 9% + SGST 9% |
| Any other Indian state | `INTER` | IGST 18% |
| Overseas | `EXPORT` | zero-rated |
| SEZ | `SEZ_WITH_PAY` / `SEZ_WITHOUT_PAY` | IGST or zero-rated |

Country is tested **first**, so a null `stateCode` on an overseas customer can never
compare equal to Adpedia's `'32'` and produce an intra-state invoice for a Dubai client.
That ordering is pinned by a test.

**Rounding** is per line, then summed. CGST is halved and SGST derived by subtraction, so
an odd paisa lands on SGST rather than vanishing. A property test over 400 random amounts
asserts `cgst + sgst === tax` exactly.

**TDS on the invoice** is computed on the **taxable value, excluding GST**
(CBDT Circular 23/2017) — ₹8,500 on ₹85,000, not on ₹1,00,300 — and is forced to zero on
exports regardless of what section is set, because overseas clients do not deduct Indian TDS.

## 2. Numbering

`src/server/services/invoicing/numbering.ts`

Allocated by Postgres under `SELECT … FOR UPDATE` inside the creating transaction.
**A 50-way concurrent allocation test asserts 50 distinct, gapless, sequential numbers.**

**Numbers are allocated on SEND, not on draft.** A draft carries a `DRAFT-…` marker.
Abandoning a draft therefore cannot punch a gap in the GST series — and gaps have to be
explainable (`03-invoice-audit-and-redesign.md` §2.1).

### 🔴 Two Rule 46 bugs the validator caught in my own seed

1. `ADP/EXP/{FY}/{SEQ:4}` renders `ADP/EXP/26-27/0004` — **18 characters**, over the
   16-character limit. All the secondary series were rebuilt as 4-character prefixes:
   `ADPX` (export), `ADPC` (credit note), `ADPR` (receipt), `ADPS` (self-invoice),
   `ADPP` (proforma).
2. The stored FY label is `2026-27`, not `26-27`, so every number rendered two characters
   longer than the format you confirmed. `shortFy()` now normalises it inside the
   numbering service, where no caller can get it wrong.

The seed re-validates every series at sequence 9999 and refuses to run if any would exceed
the limit.

## 3. The LUT guard

`src/server/services/invoicing/lut.ts`

A **hard block at send**, not a warning:

> No valid LUT on file for FY 2026-27. File Form RFD-11 on the GST portal, or raise this
> invoice with IGST instead.

The invoice detail screen shows the block before you try, and the rendered document turns
its LUT panel red. Tested both ways — blocked with no LUT, sends once one exists.

## 4. Posting rules

`src/server/services/accounting/rules/invoice.ts` — pure functions, property-tested.

**Invoice** (intra-state, ₹1,00,300): `Dr 1100 AR` / `Cr 4020 + 4030 revenue` /
`Cr 2110 CGST + 2120 SGST`. Round-off posts to its own line so the trial balance never
carries a silent residue.

🔴 **No TDS entry at invoice time.** The customer may not deduct at all.

**Receipt**: `Dr 1010 Bank 91,800` / `Dr 1310 TDS Receivable 8,500` / `Cr 1100 AR 1,00,300`.
Creates the `TdsReceivable` row tagged with FY, quarter and section — the record that will
later reconcile against Form 26AS.

**Cancellation** keeps the number and posts a reversal. Refused outright if any receipt
exists against the invoice — that needs a credit note.

## 5. AR ageing

`src/server/services/sales/receivables.ts`

```
collectible = grandTotal − received − tdsCredited − tdsStillExpected
```

A ₹1,00,300 invoice where the client deducts ₹8,500 is **fully settled by ₹91,800**.
Treating the TDS as collectible would make every paid invoice look permanently overdue
until the follow-up list is worthless. Four tests pin this.

## 6. ⚠️ Deferred: the Playwright PDF worker

> **Done later** — see [33-pdf-worker.md](33-pdf-worker.md). The document route now returns a
> real PDF, and building it uncovered three tax-mode display bugs and a two-page layout.

**Done:** `renderInvoiceHtml()` produces the finished document from database rows through
`templates/invoice/tax-invoice.html`, served at `/api/invoices/[id]/document`. Four tests
assert the real figures, Indian digit grouping, amount in words, CIN, the corrected
VIII/318 address, the SAC column honouring the print setting, and that no placeholder
sample data survives.

**Not done:** HTML → PDF via headless Chromium in a BullMQ worker. It needs a ~150MB
browser download, which is a deliberate install rather than something to do unannounced.

```bash
npx playwright install chromium        # ~150MB, then the worker is a small addition
```

Until then the document prints to PDF correctly from a browser — the `@page { size: A4 }`
rules are already in the template.

Also deferred from the phase scope: dedicated Projects and Service Items screens. Both
models are seeded and used (the demo invoice carries a project); they just have no CRUD
UI yet.

## 7. Screens

| Route | |
|---|---|
| `/customers` | list with the tax treatment each one attracts |
| `/customers/new` | form that shows the derived mode live; refuses a GSTIN/state mismatch |
| `/invoices` | list + collectible / overdue / TDS-expected tiles |
| `/invoices/new` | live totals via `/api/invoices/preview` — the same engine that saves |
| `/invoices/[id]` | document, send, cancel, and the ledger entry behind it |

## 8. Tests — 104

| File | |
|---|---|
| `tax.test.ts` | 22 — modes, rounding properties, SAC summary, TDS, ageing arithmetic |
| `posting-rules.test.ts` | 14 — invoice/receipt postings, Rule 46, short FY |
| `invoicing.integration.test.ts` | 7 — **50-way concurrent numbering**, LUT guard |
| `invoice-lifecycle.integration.test.ts` | 10 — draft → send → receipt → cancel, all three modes |
| `render.integration.test.ts` | 4 — document output |
| plus Phase 0 | 47 |

## 9. Try it

```bash
npm run pg:start && npm run dev
npx tsx --env-file=.env scripts/demo.mts     # creates ADP/26-27/0026 and settles it
```
