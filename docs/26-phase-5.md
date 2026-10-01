# 26 · Phase 5 — TDS Compliance

**Status: done.** Typecheck and lint clean, **208 tests** (104 unit + 104 integration).

Phase 3 made TDS *correct*. This phase makes it *filable*.

---

## 1. Due dates, and the one that catches people

| | |
|---|---|
| Deposit (Apr–Feb) | **7th** of the following month |
| Deposit (**March**) | 🔴 **30 April**, not 7 April |
| 26Q/24Q/27Q — Q1 … Q4 | 31 Jul · 31 Oct · 31 Jan · **31 May** |
| Form 16A / 16 | within **15 days** of the return due date |

March is the exception everyone trips over, and Q4's return is due in May rather than
April. Both are tested.

## 2. Interest — a single day late costs a full month

`s.201(1A)` charges per month **or part of a month**:

```
1%    from the date the tax was DEDUCTIBLE to the date it was deducted      s.201(1A)(i)
1.5%  from the date it was DEDUCTED       to the date it was deposited      s.201(1A)(ii)
```

`monthsOrPart()` implements "or part" literally — 8 October against a 7 October deadline
is one whole month, not one day. The TDS screen shows the live consequence:

> 6 deductions past the deposit deadline. Interest runs at 1.5% a month, or part of a
> month — a single day late costs a full month. Paying today would add ₹5,166.67.

That number moves every month end, which is the point of showing it.

## 3. s.234E late fee — capped

₹200 a day from the return due date, **capped at the TDS in the return**. A ₹5,000 return
filed five months late owes ₹5,000, not ₹30,200. The cap is where most naive
implementations go wrong, so there is a test for exactly that case.

## 4. Challans

One challan covers **one section** — the service refuses to mix them, because the ITNS 281
counterfoil carries a single section code and the RPU rejects the alternative.

Validated on entry: **BSR code is 7 digits**, challan serial up to 5. The CIN is derived
as `BSR + date + serial` when not supplied.

```
Dr 2230 TDS Payable — 194C   6,000      the liability cleared
Dr 5500 Office & Admin         560      interest and late fee are EXPENSE, not liability
Cr 1010 Axis Bank            6,560      the whole outflow
```

Interest and late fee deliberately do **not** reduce the TDS liability — they are a cost
of being late, and burying them in 2230 would make the liability untraceable.

## 5. 🔴 The pre-flight validator

Returns are rejected by the RPU for a small set of reasons. All of them are caught before
the file is handed over:

| Code | Severity | |
|---|---|---|
| `NO_PAN` | error | a deductee with no PAN — the return cannot be filed |
| `BAD_PAN` | error | wrong format — five letters, four digits, one letter |
| `NO_CHALLAN` | error | a deduction not linked to any challan |
| `CHALLAN_MISMATCH` | error | challan amount ≠ the deductions linked to it |
| `TOTAL_MISMATCH` | error | deductions total ≠ challans total |
| `NO_TAN` | error | no TAN on the company |
| `LATE_DEPOSIT` | warning | deposited after the 7th — interest applies |
| `LATE_FILING` | warning | past the return due date — s.234E |

Each message names the deductee, the amount and the consequence:

> Maneesh Unnikuttan has no PAN. The return cannot be filed without one, and s.206AA
> requires deduction at 20%.

> Challan 0510308…: ₹9,999.00 deposited but ₹6,000.00 of deductions are linked. The RPU
> will reject this.

`readyToFile` is false while any error remains, and the CSV header says
`Pre-flight,FAILED` so a bad export cannot be handed over by accident.

A PAN-less deductee is also marked with **reason code `C`** — the higher-rate flag the
return format requires.

## 6. 🔴 Export for the CA's RPU, not an FVU file

Third time this decision has been made the same way — GSTR-1, GSTR-3B, and now the TDS
returns. NSDL's RPU and FVU formats are versioned and break silently; generating them here
means discovering a failure at the filing deadline. What this produces is a validated,
deductee-wise CSV the CA imports.

```
GET /api/tax/tds/export?form=26Q&fy=2026-27&quarter=2
```

Forms split by section automatically: **192 → 24Q**, **195 → 27Q**, everything else → **26Q**.

Real output from the demo data:

```
Deductee Name,PAN,Section,Date of Payment,Amount Paid,TDS Deducted,Rate %,...,Reason Code
Exalture Software Lab,AABCE1234F,194C,2026-09-08,200000.00,4000.00,2.00,,,,
Akash Raveendran,ABCPD1234E,194J,2026-09-10,80000.00,8000.00,10.00,,,,
Maneesh Unnikuttan,,194J,2026-09-15,20000.00,4000.00,20.00,,,,C
Praveen C D,ABCPE5678F,194J,2026-09-20,40000.00,5850.00,10.00,,,,
```

Praveen's ₹5,850 on a ₹40,000 base is the threshold crossing from phase 3, visible in the
return itself.

## 7. Screens

`/tax/tds` — what is owed and by when, live interest, challan entry, and the return with
its pre-flight result. Form and quarter are switchable; the CSV button follows the
selection.

## 8. Still open

- 🔴 **TDS rates remain placeholders** — the fourth phase to say so. The machinery is

> **Superseded:** the rates and slabs were filled in later — see [32-tax-rates.md](32-tax-rates.md). They are statutory as at 01 Apr 2025 and still need the CA's sign-off.
  complete and correct; the numbers it reads are not confirmed. This is the single thing
  blocking live use.
- 🔴 **PANs for the freelancers.** The validator will refuse to pass a return without them,
  which is the right behaviour but also a hard stop.
- ⚠️ **Employee PANs** are not seeded, so 24Q will fail its pre-flight too.
- ⚠️ **No dedicated compliance calendar screen.** Due dates are computed and surfaced
  where they matter — the TDS page shows the next deadline and days remaining, GST shows
  both return dates — but there is no single calendar view.
- **TDS receivable and the 26AS reconciliation** are phase 6. This phase covers only what
  Adpedia deducts and pays.
