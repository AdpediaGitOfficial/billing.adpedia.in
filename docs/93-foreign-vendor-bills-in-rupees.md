# 93 · Foreign vendor bills in rupees

docs/91 fixed income. This is the mirror image, and quieter: a vendor bill had **no currency at
all**. A DigitalOcean bill for $100 had to be keyed as 100 and was posted as ₹100 — so whoever
entered it had to convert by hand first, and the reverse charge (18% IGST) and the s.195 TDS were
worked out on whatever number they typed. `VendorBill.currency` and `fxRate` existed in the
schema and were set by nothing and read by nothing.

Assumed, because it was not answered: **existing foreign bills were keyed in rupees**, so unlike
invoices (docs/92) there is nothing to correct. A bill that was keyed in dollars would be a rupee
bill with the wrong number, and only its owner knows.

## 1. How a bill works now

- For an overseas vendor the form asks for the **bill currency** (USD by default) and the
  **exchange rate** — filled from a live lookup for the bill date (docs/94) and changeable, then
  frozen on the bill when it is saved. Line amounts are in the bill's currency.
- **A foreign bill is not saved without a rate**, unlike an invoice draft. The TDS and the
  reverse charge are worked out when the bill is saved, on the rupee value, and a rate of 1
  would work them out on dollars.
- The document stays in its own currency. `grandTotalInr` is stored: the sum of every cost
  account and tax head converted on its own — which is exactly what payables was credited.

## 2. What posts

| | |
|---|---|
| Approval | each cost account converted, payables credited with the **sum** of the converted parts (balances to the paisa) |
| Reverse charge | 18% of the **rupee** taxable value; the self-invoice posts in rupees |
| TDS | decided on the rupee value (the thresholds and rates are rupee figures); the deduction, the 27Q row (`TdsDeduction`) and the TDS payable entry are rupees. `tdsAmountInr` keeps the exact rupee figure; `tdsAmount` carries its equivalent in the bill's currency, which is only what the vendor is **not** paid |
| Payment | typed: the **rupees that left the bank**. Payables is cleared at the bill's rate; the difference is realised forex — more out than the payable carried is a loss (5900), less a gain (4920) |

🔴 **A target, not a rounding per payment.** What a payment clears is the share of the payable it
brings the bill to, less what earlier payments *actually* cleared — read from the journal, so a
payment cancelled and entered again cannot leave drift. The last payment settles exactly what is
left. A bill closed within the half-unit tolerance (USD 99.80 of 100.00 counts as paid) clears
payables to ₹0.00, not to 99.8% of it — a test removes that rule and fails.

## 3. What reads it

Payables and its ageing (`outstandingInr`, in proportion to what is still owed), the second
ageing report, the approvals total, the PAN register's per-vendor billed total, and the
cumulative TDS threshold (`cumulativeThisFy` — in rupees, each bill at its own rate). The
payables total agrees with 2000 — a test, with a rupee bill and a USD one open.

The vendor ledger's mixed-currency warning now fires only for a foreign bill booked with no rate.
The bank matcher no longer offers foreign bills (a bank line is rupees).

🔴 **The sweep** (`tests/fx.test.ts`) now covers vendor bills as it covers invoices: no
database-side `_sum` over them, and every file that reads them converts or is named with the
reason it does not add amounts up. Verified by removing the conversion from one reader.

## 4. What is still open

- **One rate for everything on a bill.** The reverse-charge IGST (CBIC's notified rate) and the
  s.195 TDS (the SBI TT buying rate) are technically different rates. The one rate on the bill is used
  for both — **a CA question**, as it is for GSTR-1 in docs/91.
- **A card payment** is a rupee debit that includes the bank's markup. It lands in forex loss
  with the rest of the difference rather than in bank charges.
- **No balance-sheet revaluation** of open foreign payables at the closing rate (Ind AS 21); only
  realised differences are booked, at payment.
- **A foreign bill cannot be edited** after saving — as no bill can. Cancel and re-enter.
- **Expenses** in a foreign currency (a card swipe with no bill) are a separate path and are not
  covered here.
