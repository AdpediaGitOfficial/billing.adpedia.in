# 23 · Phase 2 — GST

**Status: done.** Typecheck and lint clean, **128 tests** (80 unit + 48 integration).

---

## 1. The GST position is read from the ledger, not from invoices

`src/server/services/tax/gst-ledger.ts`

Summing invoices would be the obvious approach and it would be wrong. Input GST arrives
from vendor bills and expenses, reverse charge from self-invoices, and credit notes
reverse output tax. So the position is read from **journal movements on the GST
accounts** — 2110/2120/2130 for output, 1210/1220/1230 for input, 2140/1240 for RCM.

Every source counts the moment it posts, and the GST screen can never disagree with the
trial balance.

## 2. Periods are QRMP-aware

`src/server/services/tax/periods.ts`

Adpedia is well under ₹5 crore, so quarterly filing with monthly payment applies. The
company carries `gstFilingFrequency` (`MONTHLY` | `QUARTERLY`, defaulting to quarterly).

| | GSTR-1 due | GSTR-3B due |
|---|---|---|
| Monthly | 11th of the following month | 20th |
| **QRMP** | 13th after the quarter | **24th** — Kerala's state group |

⚠️ The 22nd/24th split is by state group. Kerala sits in the 24th group — **confirm with
your CA**, because getting it wrong is a late-filing fee.

Quarters follow the **financial** year: Q1 Apr–Jun through Q4 Jan–Mar.

## 3. GSTR-1

`src/server/services/tax/gstr1.ts` — six tables built:

| Table | What |
|---|---|
| **b2b** | registered recipients, one row per invoice per rate |
| **b2cs** | unregistered, consolidated by place of supply and rate |
| **exp** | exports, marked `WOPAY` when a LUT is linked and `WPAY` when it is not |
| **cdnr** | credit notes |
| **hsn** | SAC summary — built whether or not the invoice prints the code |
| **docs** | document series issued, with cancellations |

It also raises warnings rather than silently producing a wrong return:

- a zero-rated invoice with no LUT linked → *must be reported WPAY with IGST, or the LUT must be filed*
- an inter-state B2C supply over ₹2.5L → *belongs in table B2CL, which this export does not yet build*
- any line without a SAC → *a 4-digit SAC is mandatory on B2B invoices at this turnover*

## 4. GSTR-3B

`src/server/services/tax/gstr3b.ts` — maps the ledger to tables 3.1(a), 3.1(b), 3.1(d),
4(A), 4(C) and 6.1.

The one rule worth stating out loud: **reverse charge is always paid in cash** and can
never be discharged with existing ITC. Output tax settles with ITC first and the
remainder in cash; RCM is computed separately and labelled as cash-only.

## 5. 🔴 Export for the CA, not a portal filing

Both returns produce **CSV**, not a GSTN JSON payload. The reasoning is the same as the
TDS returns in `02-recon-tds-mobile-pdf.md` §B2: the GSTN schema and the offline utility
are versioned, and hard-coding either means silent breakage at the worst possible moment.

Every file carries a header line saying so:

```
# Prepared for review — this is not a portal filing
```

Cells are RFC 4180 quoted — a customer name containing a comma must not shift every
column, and there is a test for exactly that.

```
GET /api/tax/gst/export?return=gstr1&period=2026-Q2
GET /api/tax/gst/export?return=gstr3b&period=2026-Q2
```

## 6. LUT register

`/settings/lut` — and the ARN is validated rather than trusted:

```
AD320325043063O
└┬┘└┬┘└┬┘└──┬─┘│
 │  │  │    │  └ check character
 │  │  │    └ serial
 │  │  └ MMYY — March 2025, so it covers FY 2025-26
 │  └ state 32 (Kerala)
 └ prefix
```

Three refusals, each naming the problem:

| Input | Refused with |
|---|---|
| `AD320324005917B` for FY 2026-27 | *was filed in 03/2024, which covers FY 2024-25 — not FY 2026-27. A LUT is valid for one financial year only.* |
| An ARN from state 27 | *issued in state 27, but the company is registered in 32.* |
| Anything malformed | *Not a recognisable ARN.* |

## 7. Screens

- **`/tax/gst`** — period picker, output/ITC/net/RCM tiles, filing status with days left,
  the GSTR-3B table mapping, B2B rows, exports, HSN summary, and both CSV buttons.
- **`/settings/lut`** — register with current/expired/future status and the add form.

The red LUT alert appears on the GST screen, the LUT register, **and** the dashboard,
because it blocks sending an export invoice.

## 8. Two bugs the tests caught

**`entryNo` allocation was racy.** `findFirst(orderBy desc) + 1` is exactly the pattern
invoice numbering avoids — two concurrent postings can claim the same number. The unique
index made it fail safe rather than corrupt, but it would error under load. Now the
`FinancialYear` row is locked `FOR UPDATE` before allocating, the same mechanism the
invoice series uses.

**Integration tests shared one database and ran in parallel.** Assertions about seeded
state passed or failed depending on which file ran first. Fixed properly:

- `prisma/seed/index.ts` exports a callable `seedAll(prisma, opts)`
- `tests/helpers/db.ts` → `resetDb()` TRUNCATEs and reseeds
- every integration file calls it in `beforeAll`
- `--no-file-parallelism` on the integration run

`TRUNCATE` rather than `DELETE` is deliberate: the no-hard-delete triggers are
`BEFORE DELETE` and would correctly refuse a cleanup. `TRUNCATE` fires `BEFORE TRUNCATE`
triggers, of which there are none — so the production guard stays fully intact while
tests still start from a known state.

## 9. Practical note

`npm run build` and `npm run dev` share `.next`. Running a production build while the dev
server is up leaves it with a half-written directory and `Cannot find module './897.js'`.
Stop the dev server, `rm -rf .next`, restart.

## 10. Still open

- ⚠️ **QRMP 22nd vs 24th** — confirm Kerala's group with your CA
- ⚠️ **Is Adpedia actually on QRMP?** The default assumes yes; it is one field to change
- **B2CL** (inter-state B2C over ₹2.5L) is warned about but not built — no such supply exists yet
- **Input tax credit is zero** until vendor bills arrive in phase 3; the screen says so
  rather than leaving a bare zero
