# 32 · TDS rates and profession tax slabs

**Status: filled in.** 364 tests, typecheck and lint clean, production build passes.

> ⚠️ **These are not a CA's opinion.** They are the statutory rates and thresholds in force
> from **1 April 2025**, stated to the best of my knowledge. Two things must still happen
> before the first live deduction: your CA signs this table off, and it is rechecked against
> the **Finance Act 2026** for FY 2026-27. Rates change nearly every February.

---

## 1. TDS — eleven sections

| Code | What it covers | Company | Individual/HUF | No PAN | Threshold | Form |
|---|---|---|---|---|---|---|
| `192` | Salary (incl. director remuneration as salary) | slab | slab | 20% | — | 24Q |
| `194J` | Professional fees | 10% | 10% | 20% | ₹50,000/yr | 26Q |
| `194J-TS` | Technical services | **2%** | **2%** | 20% | ₹50,000/yr | 26Q |
| `194J-DIR` | Director fees *not* paid as salary | 10% | 10% | 20% | **none** | 26Q |
| `194C` | Contractors | 2% | **1%** | 20% | ₹30,000 single / ₹1,00,000 yr | 26Q |
| `194H` | Commission, brokerage | **2%** | **2%** | 20% | ₹20,000/yr | 26Q |
| `194I-A` | Rent — plant, machinery, **equipment** | **2%** | **2%** | 20% | ₹6,00,000/yr | 26Q |
| `194I-B` | Rent — land, building, furniture | 10% | 10% | 20% | ₹6,00,000/yr | 26Q |
| `194A` | Interest other than on securities | 10% | 10% | 20% | ₹10,000/yr | 26Q |
| `194Q` | Purchase of goods from one seller | 0.1% | 0.1% | **5%** | ₹50,00,000/yr | 26Q |
| `195` | Non-residents | 20%* | 20%* | 20% | **none** | 27Q |

\* s.195 is the fallback. The real rate comes from the DTAA.

### What changed, and why it mattered

Four of these were wrong or missing in the placeholder table:

1. 🔴 **`194H` was 5%; it is 2%.** Cut by the Finance (No. 2) Act 2024 w.e.f. 1 Oct 2024.
   Deducting 5% is over-deduction the payee can only recover by filing a return.
2. 🔴 **`194I-A` did not exist.** Equipment rent is **2%**, against 10% for premises. For a
   production company hiring cameras, lighting and grip, putting that on the premises row
   **over-deducts fivefold**.
3. 🔴 **`194J-DIR` did not exist.** s.194J(1)(ba) director fees carry **no threshold** — TDS
   from the first rupee. Running them through the ₹50,000 professional threshold
   under-deducts for the whole year. Shinelal is paid as salary so this does not bite
   today; the row exists so a future sitting fee is not quietly missed.
4. **`194A` and `194Q` were absent**, so interest on a director's loan had no section at all.

### Three rules written into the table

- 🔴 **All rates are on the taxable value, excluding GST** (CBDT Circular 23/2017). Deducting
  on the GST-inclusive figure over-deducts by 18% of the tax.
- 🔴 **No surcharge or cess on payments to residents.** They apply only to s.192 and s.195.
  Adding 4% cess to a 194J payment is common and expensive.
- 🔴 **`194C` is 1% or 2% by the deductee's PAN**, 4th character — `P` individual, `C`
  company. Guessing from a trade name is how a proprietor billing as "XYZ Studios" gets
  deducted at 2% and raises a grievance.

The `194J` vs `194J-TS` split (10% vs 2%) is the most argued point in a 194J assessment.
Worth asking your CA **once per vendor**, not per bill.

### Dating, not editing

Every row is dated `01 Apr 2025`. When the Finance Act 2026 changes something it becomes a
**new row with a new effective date** — never an edit. `rateAsOf(code, documentDate)` means
an invoice raised in August keeps reproducing August's rate however often it is reopened.

## 2. Kerala profession tax

The slab figures were already the correct published half-yearly table, so they are
unchanged. What was added is the check that proves it:

| Half-yearly earnings | Per half year |
|---|---|
| up to ₹11,999 | nil |
| ₹12,000 – ₹17,999 | ₹120 |
| ₹18,000 – ₹29,999 | ₹180 |
| ₹30,000 – ₹44,999 | ₹300 |
| ₹45,000 – ₹59,999 | ₹450 |
| ₹60,000 – ₹74,999 | ₹600 |
| ₹75,000 – ₹99,999 | ₹750 |
| ₹1,00,000 – ₹1,24,999 | ₹1,000 |
| ₹1,25,000 and above | **₹1,250** |

🔴 **₹1,250 × 2 = ₹2,500 a year — exactly the ceiling in Article 276(2) of the
Constitution.** Any table totalling more would be wrong on its face whatever a circular
said, so `seedProfessionTax` now *asserts* it rather than trusting the numbers.

Slabs are set by the **local body**, so Chalakudy's own notification is the one that
governs and should be confirmed.

Deducted in September (H1, Apr–Sep) and March (H2, Oct–Mar). Due 31 August and 28 February.

### 🔴 The bug this found

The lookup matched `earnings >= from && earnings <= to`. The published table is written in
whole rupees — …11,999 then 12,000 — so **₹11,999.50 matched no band at all** and silently
returned zero tax.

That is the worst kind of wrong: a zero deduction looks exactly like an employee genuinely
below the first slab, so nobody would ever question it. A mid-month joiner produces
fractional half-year earnings routinely.

Fixed by matching on the **lower bound only** — the highest band whose floor the earnings
reach — which removes the gap entirely. Covered by tests at four boundaries, plus a test
that the published table has no gaps at all.

## 3. The PAN register

PANs could not be filled in: none have been supplied, and a PAN is a real government
identifier that cannot be inferred or generated. What was built instead is the intake and
the chase list, at **`/tax/pan`**.

🔴 **A format-valid PAN is not a verified PAN.** `ABCDE1234F` passes every check in this
system and may belong to nobody. Quoting a wrong but well-formed PAN is **worse than
quoting none**: the deduction is reported against a stranger, the real payee never sees it
in their 26AS, and the correction is a revised return. So `panVerified` means "checked
against the Income Tax portal" and nothing in the app sets it — typing a PAN in is not a
portal check.

The register shows, per person, what the gap costs: the rate actually being applied against
the rate that would apply with a PAN, and the rupees over-withheld this year. Against the
current demo data that is already **₹2,000** on one freelancer.

It also flags:

- **Duplicate PANs** across two parties — one is wrong, or the same person is on file
  twice; either way 26Q aggregates their payments under one deductee and computes
  thresholds against the wrong total.
- **An employee PAN whose 4th character is not `P`** — it must be an individual's.
- **A freelancer whose PAN says company or firm** — the PAN decides 194C at 1% vs 2%, and
  the contradiction usually means one of the two records is a typo.
- **Foreign suppliers**, where no Indian PAN is expected but a **TRC and Form 10F** are
  needed for the treaty rate under s.195.

Entry is either per row or by pasting a list — "Name, PAN" in any order, commas, tabs or
pipes, with loose name matching so "Kiran N.S." finds "Kiran N S". Anything that matches
nobody is **reported, never guessed at**, and a malformed PAN is rejected rather than
stored: a bad value looks like progress on the chase list while being worth less than a
blank.

## 4. What is still outstanding

These remain blocked on you or your CA — the rates being filled in does not unblock them:

- **🔴 The PANs themselves.** Thirteen people, none on file. Enter them at `/tax/pan` —
  per row, or paste the list in one go. Then verify them in bulk on the Income Tax portal
  and set `panVerified`.
- **Annual tax estimates per employee** for the s.192 calculation. The system prorates;
  the CA supplies the estimate.
- **Chalakudy's profession tax notification**, to confirm the local body's schedule.
- **`194J` vs `194J-TS`** per vendor — a judgement call, once each.
- Recheck the whole table against the **Finance Act 2026**.
