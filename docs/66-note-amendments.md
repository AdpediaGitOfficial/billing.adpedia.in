# 66 · Amending a note that has been filed — table 9C

**Status: done.** 891 tests (382 unit + 509 integration), typecheck and lint clean,
production build passes.

docs/52 built this for an invoice: a filed document is never edited, s.37(3) corrects it by
reporting the revised particulars in a later return against the original number and date, and
GSTR-1 table 9A carries them. A credit or debit note has the same problem and its own table —
**9C** — and until now nothing here could do it.

It is not table 9A with a different number, and the reason is one statute.

---

## 1. 🔴 A credit note has two deadlines; a debit note has one

This is what the whole module turns on, and it is invisible if 9C is treated as a copy of 9A.

| | |
|---|---|
| **s.37(3)** | when the amendment may be **reported** — 30 November following the financial year of **the note** |
| **s.34(2)** | when a **credit** note may still reduce output tax — 30 November following the financial year of **the invoice** |

Those are different statutes answering different questions, measured from different documents,
and they come apart whenever a note is issued in a later financial year than the invoice it
credits — which is ordinary.

So: **increasing a credit note after the s.34(2) date is refused**, however open the reporting
window is. The relief it claims is one the statute has already closed, and the refusal says
what to do instead — a commercial credit note under docs/48, where the client is credited and
no GST is recovered.

🔴 **Reducing one is always allowed.** Giving back tax that was over-recovered is not
something a statute hurries to bar, and the screen says so rather than refusing by symmetry.

🔴 **A debit note has no s.34(2) at all.** s.34(3) imposes no time limit — docs/53 established
that — so no deadline is computed for one, and the screen says *"a debit note has no time
limit at all"* rather than leaving a blank where a date would be.

### 🔴 And when both deadlines have passed, the reader gets one message

The first version let the s.34(2) branch overwrite the s.37(3) one, so a note years out of
time was refused for the wrong reason. If the amendment cannot be **reported** at all, whether
s.34(2) would have allowed the relief is moot — s.37(3) is checked first and is not
overwritten.

## 2. What it keeps from docs/52, and why

- **Only the difference is posted**, dated in the amendment period. The period the note sits
  in is locked by the return that reported it.
- **The rate comes from what was reported**, never from today's table — an amendment corrects
  a figure and must never silently re-rate the supply because a notification moved.
- **A second amendment starts from the corrected figures**, not the original.
- **The signs mirror the note**: a credit note debits revenue and the output heads and credits
  the receivable, so an amendment that increases the credit does more of the same.

And one thing it does *not* keep: an invoice amendment can change the recipient's GSTIN and
the place of supply, which is what lets it move tax between heads. A note's heads follow the
invoice it credits, so 🔴 only the value can be amended here. Offering the rest would be
offering to correct the wrong document.

## 3. 🔴 A note that never carried tax cannot be given any

docs/48 established the commercial credit note: issued past the s.34(2) deadline, carrying no
GST, not reported in GSTR-1, and saying so on its face. An amendment that put tax on one would
recover output tax the deadline has already closed, so it is refused — and an amendment that
only corrects its **value** is allowed and reported, because the value filed was wrong.

## 4. What the tests and the screen found

- My own arithmetic: a test asserted ₹3,600 of CGST on a ₹40,000 amendment at 18%. It is
  ₹7,200 of tax, ₹3,600 **each** head. The code was right.
- A fixture tried to raise an invoice into a period the GSTR-1 filing had already locked
  (docs/44), which is the lock doing its job in a test that had forgotten about it.
- 🔴 To test the asymmetry at all, the note has to be in a **later financial year than its
  invoice**. With the note in the invoice's own year the two deadlines coincide to the day and
  the whole distinction is invisible — the fixture says so, at length, because the next person
  to read it will wonder why the dates look arbitrary.
- On screen, three warnings stacked under the identical heading *"Before you do"*. That is the
  docs/60 lesson in miniature: a reader scrolls past the third, and the third is sometimes the
  one that matters. One alert, with a list.
- And one of those warnings read *"nothing is different from what was already reported"* —
  before the form had been touched. Of course nothing was. It is dropped from the page's
  opening preview and still fires on submit, where it means something.

## 5. Still open

- **No amendment to a note's recipient or place of supply.** Correct the invoice instead, and
  the note follows it — which is right, but nothing says so at the moment somebody looks for
  the field.
- **An amendment cannot be amended away.** Like docs/52, a mistaken amendment needs another
  amendment; there is no `cancelNoteAmendment` in docs/51's family.
- **Table 9C is not split by recipient registration.** The portal separates amended notes to
  registered and unregistered recipients; every note here is against a B2B invoice, so the
  distinction has not arisen.
- Carried forward: service-item CRUD, swipe gestures and the performance budget.
