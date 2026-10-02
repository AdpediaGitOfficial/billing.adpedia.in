# 52 · Amending what has been filed

**Status: done.** 650 tests (314 unit + 336 integration), typecheck and lint clean,
production build passes.

Every refusal in docs/50 and docs/51 ended by pointing at a revised return, and the system
had no idea what one was. This is what they were pointing at — on both sides, because the two
taxes do it quite differently.

---

## 1. GST: the invoice is never edited

🔴 A filed invoice stays exactly as filed. The client holds a copy, the portal has it, and
everything in this system already refuses to touch it — the period is locked (docs/44), the
bill-to details are frozen (docs/41), the reversals refuse outright (docs/51).

s.37(3) corrects it by reporting the **revised particulars in a later return**, against the
original number and date. So an amendment is its own document, in its own period, and the
original is superseded rather than replaced. `GstAmendment` holds both sides — what was
reported and what it should have said — and GSTR-1 grows a **table 9A**, which the CSV export
carries so the CA can actually file it.

The deadline is the same as a credit note's, for the same reason: 30 November following the
financial year of supply.

### 🔴 The correction that moves money without changing the value

The case worth building for. An invoice to a Karnataka customer, keyed with a Kerala state
code, comes out intra-state: ₹9,000 CGST and ₹9,000 SGST, paid to the wrong government. The
amendment changes no rupee of the invoice value and still moves ₹18,000 between tax accounts:

| | Original | Revised | Posted |
|---|---:|---:|---:|
| Taxable value | 100,000 | 100,000 | — |
| CGST | 9,000 | 0 | **(9,000)** |
| SGST | 9,000 | 0 | **(9,000)** |
| IGST | 0 | 18,000 | **18,000** |
| Invoice value | 118,000 | 118,000 | **nil** |

The recipient cannot claim the credit until it is reported under the right head, so this is a
correction they chase *us* for. The tax mode is derived from the place of supply exactly as it
is on an invoice — displayed, never offered.

### Only the difference, and only in the amendment period

The invoice's own month is locked by the return that reported it, so re-posting the whole
invoice there would be both refused and wrong. The amendment posts the **delta**, dated in the
period that carries it. A particulars-only correction — a wrong GSTIN — posts nothing at all,
and the code says so rather than building an empty journal the balance check would reject.

A second amendment starts from the **amended** state, not from the original.

## 2. TDS: the correction statement, and what it re-opens

🔴 Recording a correction is what makes the docs/50 refusals stop refusing — correctly, and
only as far as the correction goes.

The guards compare the live books against *what was reported*. A correction statement changes
what was reported. So rather than adding an override, `recordTdsCorrection` simply **replaces
the snapshot**: a C3 that removes a deductee lowers `tdsDeducted`, and the payroll run behind
it becomes reversible because the return no longer claims it.

Nothing else becomes reversible — which is the property an override would have thrown away,
and it is tested directly: after a C2 frees one challan, the other quarter's filing still
blocks its own.

The categories are NSDL's: C1 deductor · C2 challan · C3 deductee · C4 salary · C5 PAN ·
C9 challan added. A correction cannot be dated before the return it corrects.

## 3. What the tests and the rendering found

- 🔴 **`Invoice.placeOfSupply` holds a state code, and I was comparing a label.** Every
  preview believed the place of supply had changed, so an amendment with nothing in it looked
  like a real one. Worse, the second amendment re-derived the tax mode from the invoice's
  *stale* state code and silently flipped it back to intra-state.
- 🔴 **The deadline check ran after `assertPostable`**, so an amendment five days past
  30 November answered *"no financial year covers 2027-12-05"* — true, and useless. The
  preview now runs first.
- The whole loop was driven in the browser: a challan refused because the 26Q reported the
  deposit, a C2 correction recorded, and then the same cancellation accepted.

## 4. Still open

- **Credit-note amendments (table 9C)** are not built. The same shape as 9A, against a credit
  note rather than an invoice.
- **Nothing files anything.** This records what the CA files from the RPU and the portal, as
  everything in this system does — `docs/27 §1` explains why that line is where it is.
- **A correction statement does not reach the deductees.** Where a C5 fixes a PAN, the person
  whose credit moved is not told.
- **The amendment has no document.** Unlike a credit note (docs/48), there is nothing to send
  the client — on the GST side there is nothing to send, since the amendment is a return
  entry, but a client whose GSTIN was wrong will ask what changed.
- Carried forward: advance receipts, PDF statements, journal export, service-item CRUD,
  Form 16/16A issuance.
