# 71 · The company's own advance tax

**Status: done.** 946 tests (400 unit + 546 integration), typecheck and lint clean,
production build passes.

`docs/43 §5` left this: *"Advance tax instalments are not on the calendar yet. The dates and
the cumulative schedule are implemented and tested; computing the liability they are a
percentage of needs the CA's estimate, which is still outstanding."*

Waiting for the estimate was the wrong way round. The dates are statutory and do not wait for
anybody, and leaving the instalments off the calendar until somebody enters a liability means
the one thing that would prompt them to go and get one is the thing that is missing — so 15
June passes in silence.

---

## 1. 🔴 The system cannot compute this, and must not pretend to

Advance tax is a percentage of **the year's tax liability**, and that is not a number these
books hold. Taxable income is not book profit: depreciation is computed differently, s.40 and
s.43B disallow things the P&L has already taken, and the rate itself depends on whether
s.115BAA was elected (22%) or the slabs apply (25%/30%), with surcharge and cess on top.

So the liability is the CA's, recorded as `CompanyTaxEstimate` — the mirror of
`SalaryTaxEstimate`, which `docs/25` built for exactly this reason on the s.192 side.
**Superseded, never edited**: an instalment paid against an earlier estimate was correct when
it was paid, and the history of what was believed and when is the only thing that explains a
figure to somebody reading it a year later. A source is required, because a number nobody can
derive needs to say where it came from.

🔴 **Absent, not zero.** Until an estimate exists, `required`, `shortfall` and `interest` are
not computed. All three would come out as `0.00` against a liability of zero, and a screen
reading "shortfall ₹0.00" states that nothing is owed — the opposite of what is true, which is
that nobody has worked it out.

The books' own **profit before tax** is shown beside it, labelled as what the ledger says and
explicitly not the taxable income. It is context for the conversation with the CA, not the
base of a computation.

## 2. 🔴 The s.234C safe harbour is not a rounding of the instalment

```
            required   no interest at
15 June        15%          12%
15 September   45%          36%
15 December    75%          75%
15 March      100%         100%
```

The provisos to s.234C(1) forgive the **interest** on a near miss for the first two
instalments only. The shortfall still has to be made up — what is forgiven is the charge.

A system that charges interest from 15% produces a plausible, legal-looking, wrong number, and
nobody re-checks a tax computation that looks reasonable. `ADVANCE_TAX_SCHEDULE` carries
`safeHarbourPct` beside `cumulativePct` so the two cannot be conflated, and the screen prints
"no interest at 12%" next to the 15% so a reader sees both.

🔴 **The months are fixed by the statute, not counted from the delay.** Three months on each
of the first three instalments and one on the last, whatever the actual delay. It is not
s.234B's "month or part of a month", and it does not stop when the money is eventually paid —
computing it from elapsed time gives a different, larger number every day that passes.

🔴 **Paid on or before the due date.** A payment made on 20 September does not count towards
September's instalment at all. It counts towards December's, and September's interest is
charged in full regardless. "Paid in the quarter" is the natural reading and it is wrong.

## 3. 🔴 Advance tax is an asset

`Dr 1350 Advance Income Tax Paid, Cr the bank`.

It is money on account against a liability the return has not yet settled. Booking it to the
P&L understates the year's profit by whatever has been paid, and then double-counts the moment
the final tax is provided for — which is the kind of error that survives a whole year because
both halves of it look like ordinary entries.

🔴 **Account 1350 is created by a migration as well as the seed.** `docs/65 §6` learned this
the hard way with the refund-voucher series: the seed only runs on a fresh install, so without
the backfill the first payment on an existing database fails inside `postJournal` with
"account 1350 not found", and there is no screen that creates an account. Applied here before
it bit rather than after.

The challan carries the same BSR code and serial as a TDS one, and its CIN is constructed the
same way — `docs/56 §3`, including the caveat that a constructed CIN is a guess until a
statement says the same thing.

## 4. On the calendar whether or not an estimate exists

Four items, one per instalment, with the date always and the figures only when they can be
computed. An instalment inside the proviso reads **done**, because no interest is running on
it, with the detail saying it is short and why that costs nothing.

🔴 **A future instalment's gap is not a shortfall.** December's ₹3,60,000 shown in October, in
critical red, under the word "short", is `docs/56 §2`'s frightening figure that means nothing —
nothing is owed until 15 December, and after three of those nobody reads the screen. Before the
date it reads "still to pay by then", in muted type, and the amount is not highlighted.

## 5. What this leaves

- **The estimate is still outstanding in real life.** The screen now says so in the place
  somebody would look, with the books' profit beside it to take to the CA — which is the most
  this system can honestly do.
- **Nothing cancels an advance-tax payment.** `cancelledAt` and `cancelReason` are on the
  model and the position already excludes cancelled ones; the service is one more member of
  `docs/51`'s family and has no caller yet. Worth doing before a wrong challan is entered
  rather than after.
- **s.234B is not computed.** It runs at 1% a month on the shortfall of the whole year's
  advance tax from the assessment, and it is a question for the return rather than the year.
- **ROC filings** (AOC-4, MGT-7) are still off the calendar — they are keyed to the AGM date,
  which this system does not hold. Carried forward.
