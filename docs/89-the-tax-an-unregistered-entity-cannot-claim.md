# 89 · The tax an unregistered entity cannot claim

docs/88 §6 recorded a suspicion read from the code, not exercised: a personal account booking
a bill from a GST-registered vendor would debit the vendor's GST to **1210–1230 Input CGST /
SGST / IGST** as a recoverable asset. This module exercised it. It was true.

## 1. What was wrong

`previewBill` set `itcEligible` from the **vendor's** GSTIN alone (`mode !== 'NONE'`), and
`postVendorBill` debits the input-credit accounts whenever `itcEligible` is set. Nothing read
the **buyer's** registration. For an entity with no GST registration that books ₹1,800 of tax
into an asset it can never utilise — s.16(1) gives credit to a registered person — so the
expense is understated by that amount and the profit overstated by it. `expense.ts` has
refused exactly this since docs/82 §5b; the bill path never learned it.

The reverse-charge half was the same shape. For a foreign vendor `approveBill` raised a
self-invoice and posted `Dr 1240 / Cr 2140` — a recoverable asset against a liability the
entity was never shown to owe.

## 2. What it does now

`previewBill` reads `Company.gstRegistrationType` (through `isGstRegistered`, as `expense.ts`
does) and returns `registered`.

- **Unregistered, vendor charges GST.** `itcEligible` is false, the stored
  `itcBlockedReason` says why, and the existing blocked-credit path in `postVendorBill` puts the
  whole bill into the expense account. Nothing reaches 1210–1240. A warning on the preview
  says the GST is part of the cost.
- **Unregistered, explicit claim.** `itcEligible: true` is refused with the s.16(1) message,
  the same wording and rule as an expense.
- **Unregistered, foreign vendor.** `rcmIgst` is zero: no self-invoice, no 1240 debit, no
  2140 credit. The preview says reverse charge may arise and that this system will not
  account for it for an unregistered entity — **ask the CA**. Whether an unregistered
  recipient of an import of service owes IGST is a legal question nothing here can answer, and
  docs/79 already settled how to treat those: name it and stop.
- **Registered** entities are unchanged (a control in the test).

## 3. Test

`tests/unregistered-bills.integration.test.ts` posts the bills and reads the journal. With the
fix removed, the three unregistered-entity tests fail and the registered control passes.

## 4. Still open

- **A composition dealer is `isGstRegistered`.** s.10(4) denies it input credit as well, so
  both `expense.ts` and this path would still book credit for a `COMPOSITION` entity. Neither
  was changed here; no such entity exists in this system today.
- **Bills already booked** by an unregistered entity before this change would carry the credit.
  None exists in the development database (the personal account has not been created there).
  A deployed box that has one needs the bill cancelled and re-entered.
- The reverse-charge treatment for an unregistered entity is a refusal to account, not a
  ruling. If the CA says the IGST is owed, it has to be posted as a cost and a liability.
