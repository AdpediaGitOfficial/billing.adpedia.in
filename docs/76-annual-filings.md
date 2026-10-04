# 76 · The annual filings, for the year they are about

**Status: done.** 1,001 tests (411 unit + 590 integration), typecheck and lint clean,
production build passes.

`docs/72 §2` found that the registrar's obligations were being computed for the wrong financial
year, fixed those, and wrote down that **ITR and GSTR-9 had the same shape and were being left**
— because there was no fact that could clear them, and an item that can never go green is worse
than one that is early.

This supplies the fact, and closes both.

---

## 1. 🔴 The item that was present was the one that did not matter

In October 2026 the calendar showed:

- *File the company income tax return for FY 2026-27* — due 31 October **2027**
- *File the GST annual return for FY 2026-27* — due 31 December **2027**

and said nothing at all about FY 2025-26's ITR, which was due that same week.

Both were keyed off `currentFinancialYear`. An annual return is about a year that has **ended**;
the year you are in cannot be filed yet. So they read the latest year whose `endsOn` has passed,
exactly as `docs/72` made the AGM and its two forms do.

The current year's ITR is still on the calendar, as `itr-current`, marked as a date rather than
a task — *"not until the year has ended — shown so the date is on the calendar"*. Dropping it
would hide the year ahead; leaving it as the only one hid the year behind.

## 2. 🔴 Something has to be able to clear it

`docs/43 §5`'s last open item, and `docs/43 §1`'s whole premise: a calendar that nags is one
people stop reading, and an annual obligation with nothing able to clear it nags for ever once
its date passes.

Neither the income-tax portal nor the GST portal is something this system talks to, so
`gstr9FiledOn`/`gstr9Arn` and `itrFiledOn`/`itrAckNo` sit on the financial year beside
`docs/72`'s `aoc4FiledOn` and `mgt7FiledOn`, and are recorded by hand in the same form. Four
filings, one place, one shape: *everything about a year that has ended, and none of it on a
portal we talk to.*

The same guard applies to all four — a filing cannot be dated before the year it reports on had
ended.

## 3. A correction, not a change

`docs/37 §8` said: *"GST return filing does not advance the lock automatically — the comment in
`period.ts` says it should, and that wiring is not in yet."*

It does. `recordGstFiling` advances `lockedUpTo` to the period end inside the same transaction,
only ever forward, and `tests/gst-filing.integration.test.ts` has asserted it since `docs/44`.
The note went stale when that module landed and was never struck off — the same drift `docs/00
§7` warns about and `docs/60 §5` had to correct once before.

🔴 Worth saying plainly: a stale "still open" note is not harmless. It is a standing invitation
to build something that already exists, and the next session reads it as fact.

## 4. Still open

- **The GSTR-9 is not prepared by this system**, only recorded as filed. Reconciling the year
  against what was filed period by period is a real piece of work and nothing here does it.
- **No guard against recording a filing for a year the books say is unfiled underneath.** A
  GSTR-9 cannot honestly be filed while a quarter's GSTR-3B is outstanding, and nothing checks.
- Carried forward from `docs/00 §7`: server-side pagination on the three 100-row lists, and
  removing a user or changing a role.
