# 45 · Paying the GST

**Status: done.** 528 tests (293 unit + 235 integration), typecheck and lint clean,
production build passes.

---

## 1. 🔴 Filed is not paid

Docs/44 made it possible to record that a return was filed. It immediately exposed the next
gap: **nothing recorded the payment**, so a return filed with the tax unpaid read as settled.

The asymmetry was visible in the schema — TDS had a `TdsChallan` with a BSR code and a CIN;
GST had nothing, even though `SourceType` already carried `GST_PAYMENT`. The journal
vocabulary anticipated a posting that no code could make.

They are genuinely separate events, and under QRMP they are not even on the same cadence:
PMT-06 payments fall **monthly** while the return is **quarterly**.

## 2. 🔴 A CPIN is not a payment

A challan generated on the portal has a **CPIN**. Only once the bank confirms the money has
moved does it get a **CIN**.

Recording a CPIN as a payment is precisely how an unpaid liability comes to look settled, so
the CIN is required and the refusal says why:

> A payment needs its CIN — the challan identification number the bank returns once the money
> has actually moved. A CPIN alone means the challan was generated, not paid.

## 3. 🔴 Interest runs on the cash component, not the gross

This is the proviso to s.50(1), and it is the part that is most often got wrong.

Where a return is filed late, interest is charged only on the tax actually paid **through the
electronic cash ledger** — not on the portion set off against input credit that was sitting
there all along. For a company with substantial ITC, charging on the gross figure can easily
**double** the interest.

### And it is per day, unlike TDS

GST interest is 18% a year computed **per day**. TDS interest under s.201(1A) is 1.5% per
month **or part of a month** — where a single day late costs a full month.

Applying the TDS rule to a one-day GST delay would overstate it roughly thirtyfold. A test
asserts the thirty-day figure is exactly thirty times the one-day figure, which only holds
because the calculation is daily.

## 4. What it posts

| | |
|---|---|
| Dr | 2110 / 2120 / 2130 output GST, and 2140 for RCM — the liabilities being settled |
| Dr | 5600 Bank charges — 🔴 **interest and late fee are a COST, not tax** |
| Cr | 1010 Bank |

Interest and late fee are nobody's input credit. Burying them in the tax accounts would make
the GST liability look larger than it was and leave a residue that never clears.

RCM is split out on the challan because 🔴 **it must be paid in cash and can never be set off
against input credit**, however much credit is available — the same rule already enforced
when a foreign supplier's bill is approved.

## 5. The calendar now separates the two

"File GSTR-3B" and "Pay the GST" are distinct items with the same due date. A return marked
filed no longer silences the payment, because the money is the part that stops the interest
running.

## 6. Still open

- ~~**The electronic cash and credit ledgers are not modelled.**~~ Done in **`docs/46`**,
  which also changed what §4 above posts: a challan now funds the cash ledger and the
  separate set-off discharges the liability. Modelling it found that netting total credit
  against total output tax understated the cash payable, and that interest runs to the date
  the ledger is **debited** (rule 88B(1)), not to the date it was funded.
- **Nothing reconciles a challan against the portal.** The CIN is recorded on trust.
- **Interest is not auto-filled** on the payment form — `previewGstPayment` computes it and
  explains it, but the figure must be entered deliberately, because the portal's own
  computation is the one that governs.
- Carried forward: credit-note PDF, debit notes, vendor and project edit pages, the unmatch
  button, payroll and challan cancellation.
