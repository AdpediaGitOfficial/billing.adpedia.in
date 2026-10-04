# 72 · The AGM, and the two forms that run from it

**Status: done.** 961 tests (404 unit + 557 integration), typecheck and lint clean,
production build passes.

`docs/43 §5`'s second open item: *"ROC filings (AOC-4, MGT-7) are company-law obligations keyed
to the AGM date, which the system does not hold."* It holds it now, and getting there turned up
a mistake in how the calendar decides **which year** an annual obligation is about.

It also closes the gap `docs/71` opened one module earlier, on purpose — see §5.

---

## 1. 🔴 The forms run from the meeting, not from its deadline

s.137(1) gives thirty days from the AGM for AOC-4, and s.92(4) sixty for MGT-7. Both are
counted from **the date of the meeting**, not from the 30 September it could have been held by.

An AGM held on 15 August makes AOC-4 due on **14 September** — six weeks before the 30 October
that anybody working from the deadline would have written down. The error is invisible until it
arrives as a late fee, because every date involved looks plausible.

So `agmHeldOn` is recorded on the financial year, and the two deadlines are derived from it.
The form on `/settings/company` shows them live, recomputed from the field being typed into
rather than from what was last saved — the relationship is the whole point, and it is only
visible at the moment somebody changes the date.

🔴 `agmDue` is stated as the **statutory outer limit** and says so. Two further limits exist
that the books cannot see: a first AGM gets nine months rather than six, and no two AGMs may be
more than fifteen months apart — which can make the real deadline *earlier* than six months
after the year end. A register of past meetings would narrow it; this system has one year's.

## 2. 🔴 Which year the registrar is asking about

The AGM for FY 2026-27 is held in 2027. What is live in October 2026 is the AGM for **FY
2025-26**, which was due on 30 September 2026 — five days ago.

Keying these off `currentFinancialYear` would have shown a date a year away and silently
omitted the one already late. It is `docs/49 §4`'s trap asked of a different question: *the
newest open financial year is not the year you are in*, and for an annual obligation it is not
the year the obligation is about either. The ROC items read the latest year whose `endsOn` has
passed.

⚠️ The same question applies to **ITR and GSTR-9**, which are still keyed off the current year
and therefore show next year's dates. They are left alone here because there is no fact to
clear them with — see §4 — and an item that can never go green is worse than one that is early.

## 3. 🔴 Without a meeting, the obligation is the meeting

A company cannot file AOC-4 before its AGM. An overdue AOC-4 with no AGM behind it points at
the wrong form and sends somebody to the MCA portal to do something they cannot do.

So where no meeting is on record the two forms read **not applicable** — with the latest date
they could fall due, and a detail that says to record the meeting first — and the AGM itself
carries the urgency. The service refuses a filing date with no meeting behind it, a filing
earlier than the meeting, and a meeting dated before the year it reports on had even ended.

## 4. 🔴 Something has to be able to clear it

`docs/43 §5`'s third open item is that nothing is marked done by hand, so a return filed on the
portal never reads as done. For the ROC family that is fatal rather than untidy: these are
annual, and once the date passes an item with no way to clear nags for ever — which is exactly
what `docs/43 §1` says destroys a calendar.

The MCA portal is not something this system talks to (`docs/31 §6` settled the general
question), so `aoc4FiledOn` and `mgt7FiledOn` are recorded by hand beside the AGM date. Three
nullable dates on the financial year, one form, and every item in the family can go green.

🔴 **An empty field clears the date rather than being ignored.** A date entered by mistake has
to be removable, and "blank means no change" would make a wrong AGM date permanent — which
matters more here than almost anywhere, because both filing deadlines are derived from it.

## 5. 🔴 Closing the gap the last module opened

`docs/71 §5` listed "nothing cancels an advance-tax payment — modelled for, no service". That is
word for word what `docs/65 §7` said about the refund voucher, and by the time anybody came
back to that one (`docs/69`, four modules later) its postings had been filed under the wrong
identity and the service could not have been written at all.

So `cancelAdvanceTaxPayment` is written here, one module later, while the shape of it is still
in somebody's head. **A modelled-but-unserviced field is the same gap as a service with no
caller**, and this project has now found that one five times.

There is nothing to refuse against. Advance tax is not reported in a return — it appears in the
ITR as tax already paid — so until that return is filed, a challan entered in error is simply
an entry in these books. The period lock is the only guard, and it is the right one.

## 6. What this leaves

- **DIR-3 KYC**, due 30 September per director, is not here. The system knows who the directors
  are (`Employee.isDirector`) and does not hold their DINs, which is what the obligation is
  keyed to.
- **The fifteen-month rule** between AGMs, and the nine months a first AGM gets, both need a
  register of past meetings rather than one date per year.
- **ITR and GSTR-9 still read the current year** — §2. Worth fixing together with a way to mark
  them filed, not before.
- Carried forward from `docs/00 §7`: user invitations, opening balances at year-end close, IRN
  and QR on the invoice template, and server-side pagination on the three 100-row lists.
