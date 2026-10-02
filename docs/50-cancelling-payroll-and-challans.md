# 50 · Cancelling what has consequences

**Status: done.** 619 tests (314 unit + 305 integration), typecheck and lint clean,
production build passes.

Docs/49 wired up three corrections and deliberately left two alone: a payroll run and a TDS
challan, because "heavier downstream consequences… want their own thinking rather than the
pattern applied blindly". This is that thinking — and it turned out the system could not have
made the decision at all.

---

## 1. 🔴 Nothing knew whether a TDS return had been filed

The GST side got a filing record in docs/44. The TDS side never did.

That is not just a reporting gap. A filed 24Q/26Q/27Q reports every deduction in it **against
the deductee's PAN**, where it lands in their Form 26AS and they claim it. It is the single
fact that makes a payroll run impossible to unsay — and the system had no way to know it. A
cancellation had nothing true to refuse on.

`TdsReturnFiling` records the quarter, the form, the date, the 15-digit provisional receipt
number, and 🔴 **a snapshot of what was reported** — the same rule as a GST filing: what was
filed is a historical fact, and reading it live afterwards makes the one question that matters
at assessment unanswerable.

It refuses to record a filing when the quarter's deductions and challans disagree, because a
return cannot have been accepted in that state — so recording it would be recording something
that did not happen. The compliance calendar finally distinguishes *24Q still to file* from
*filed*, instead of saying "scheduled" forever.

## 2. 🔴 "The quarter is filed, so nothing may be touched" is wrong

That is the obvious guard, and it traps honest mistakes.

> A July payroll run nobody noticed until November was in **none** of the Q2 return's figures.
> Cancelling it contradicts nothing. Refusing anyway locks a genuine error behind a return it
> was never part of.

What the snapshot gives us is the figure that *was* reported. Anything above it arrived
afterwards and may go; taking the quarter **below** it means unsaying something a deductee is
already claiming. So `wouldContradictFiling` compares the live quarter total, less what is
about to be reversed, against the filed snapshot — on the *deducted* side for a payroll run
and the *deposited* side for a challan.

The refusal says the arithmetic out loud:

> 26Q for Q2 was filed on 2026-10-31 reporting 21850.00 as deposited. Withdrawing this challan
> would leave 4000.00 behind it. The deductees' credit in their Form 26AS is backed by this
> CIN…

## 3. Cancelling a payroll run

A run is not one document: payslips, a salary-payment entry, a s.192 deduction per employee,
the profession tax, and a TDS liability that may already be with the government. It refuses in
two places, and both are about something that has left the building:

| | |
|---|---|
| **The TDS is on a challan** | the money is with the government, and the employees are credited with it |
| **The quarter's 24Q reports it** | §2 — they are already claiming it in their 26AS |

Otherwise it reverses the run's journal **and the salary payment if one was posted**, marks
every s.192 deduction reversed so it leaves the challan queue and the return, and keeps the run
and its payslips on file as `CANCELLED`.

🔴 Reversing the payment is deliberate. Cancelling says the whole run was recorded in error;
leaving the payment posted would claim money left the bank for a run that no longer exists. If
the money really did move, the bank line comes back as unmatched in reconciliation — which is
exactly where a payment with no document belongs.

### And the month has to be runnable again

`PayrollRun` was unique on `(company, year, month)`. A cancelled run keeps its row, so that
index made a cancelled month **permanently unrunnable** — the correction would have been worse
than the mistake. It is now an ordinary index, and "one live run per month" is enforced in the
service, where the word *live* can be expressed.

## 4. Cancelling a TDS challan

This does not ask the government for the money back. It says the challan was recorded **here**
in error — a wrong BSR code, the wrong deductions attached, a duplicate. The deposit itself, if
it happened, is still a bank line waiting to be matched.

🔴 The deductions go back to **outstanding**, not to reversed. They were real deductions from
real payments; what was wrong is the record of depositing them. They reappear in the challan
queue with their s.201(1A) interest still running from the day they were deducted — which is
the true position, and the one a corrected challan has to settle.

## 5. A note on house style

The 🔴 marker is for the reader of the code. In docs/46 and docs/47 it had leaked into
*strings the user sees* — engine notes and screen copy — where it reads as decoration rather
than emphasis. Removed from rendered text; it stays in comments and in these documents.

## 6. Still open

- **A credit note and a set-off still cannot be reversed** (docs/46, docs/48). Both post
  journals, so the pattern applies; a note already sent to a client and a set-off behind a
  filed return each want the §2 treatment.
- ~~**Revised returns are not modelled.**~~ Done in **`docs/52`**: a correction statement
  replaces the snapshot these guards read, so recording one re-opens exactly what it corrects
  and nothing else.
- **Form 16/16A are still not issued**, so a cancelled run cannot invalidate a certificate
  that was never produced.
- Carried forward: debit notes, advance receipts, PDF statements, journal export,
  service-item CRUD.
