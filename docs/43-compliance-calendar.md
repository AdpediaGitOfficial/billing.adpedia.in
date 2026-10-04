# 43 · Compliance calendar

**Status: done.** 502 tests (285 unit + 217 integration), typecheck and lint clean,
production build passes.

---

## 1. 🔴 Every alert was state-based; none were date-based

The dashboard had five compliance alerts and all of them answered *"what is wrong right
now"* — no LUT, an unverified PAN, TDS not yet deposited. Useful, and none of them answered
*"what is due, and when"*.

A compliance calendar was in the phase 5 scope and was never built. Nothing in the system
knew that TDS deducted in July was due on 7 August, or that Kerala files its quarterly
GSTR-3B on the 24th.

## 2. 🔴 Derived from data, never a table of dates

A calendar that prints "GSTR-1 due on the 11th" every month is noise within a fortnight.
People stop reading it — and then miss the one that mattered.

An item appears here only when **there is something to do**: TDS to deposit because
deductions are unlinked, a return to file because the period has supplies in it, a LUT to
renew because overseas customers exist. Where nothing is outstanding the item still shows,
marked **done**, because "nothing to do" is itself the answer someone came for.

Against Adpedia's current books it found, unprompted:

| | |
|---|---|
| **₹68,888.88** TDS for July | **54 days overdue** |
| **₹68,888.88** TDS for August | 23 days overdue |
| Kerala profession tax, H1 | 30 days overdue |
| **₹90,738.88** TDS for September | due in 7 days |
| GSTR-1 for Q2 | due in 13 days |

## 3. 🔴 Four dates that are not what they look like

Each of these is why the deadlines are functions rather than a lookup table.

**TDS deposit is the 7th — except March, which is 30 April.** The year has ended and the
extra time is allowed. Applying the 7th blindly makes every March deposit look three weeks
late and triggers a false interest calculation.

**The TDS return is the last day of the following month — except Q4, which is 31 May**, not
30 April.

**GSTR-3B under QRMP is the 22nd or the 24th depending on the state group.** 🔴 **Kerala is
in the 24th group.** Using the 20th for a quarterly filer reports a deadline four days early,
which is harmless; the other way round is not.

**The LUT is due *before* the year it covers — 31 March.** It is not a deadline that can be
met late and tidied up afterwards: an export raised zero-rated without a current LUT is
simply not zero-rated, and the IGST becomes payable.

Advance tax carries its own trap, recorded in the schedule even though Adpedia's current
result is a loss: 🔴 **the percentages are cumulative, not per instalment.** By 15 September
the total paid must reach **45%** of the year's liability, not 45% on top of June's 15%.
Reading them as separate instalments under-pays every quarter and accrues interest under
s.234C.

## 4. What being late costs, shown where it is late

The penalty line appears only on items that are overdue or due soon — not on every row, which
would make it wallpaper.

| | |
|---|---|
| TDS deposit | 🔴 **1.5% per month *or part of a month*** under s.201(1A) — a single day late costs a full month |
| TDS return | ₹200 a day under s.234E, capped at the TDS in the return |
| Form 16A | ₹100 a day per certificate under s.272A(2)(g) |
| GSTR-1 | ₹50 a day (₹20 nil), capped |
| GSTR-3B | 18% a year on tax paid late |
| LUT | the supply is taxable — IGST payable on every export |

## 5. Still open

- ~~**Advance tax instalments are not on the calendar yet.**~~ Done in `docs/71`. Waiting for
  the estimate was the wrong way round: the dates are statutory, and leaving the instalments
  off until somebody entered a liability meant the one thing that would prompt them to get one
  was the thing that was missing.
- ~~**ROC filings** (AOC-4, MGT-7) are company-law obligations keyed to the AGM date, which the
  system does not hold.~~ Done in `docs/72`, which also found that the calendar was asking
  about the wrong financial year.
- **Nothing is marked done by hand.** An item clears when the data says so — a challan linked,
  a LUT on file. A return that was filed on the portal has no corresponding fact in the
  system, so GSTR-1 and GSTR-3B never read as done.
