# 88 · The personal account

Entity B is one person's own books: freelance income, projects, and invoices in their own
name. It is not a company and it files nothing — no GST, no LUT, no GSTR-1, no ROC. Only the
private limited company carries the legal and compliance work.

The system already knew that in principle (docs/82). In practice a person using it could not
get a first invoice saved, paid, or sent to a client who could pay it.

Found by doing what the user does: opening the invoice form as that entity, saving, sending,
and then reading the document the client would receive.

---

## 1. The form could not save

The invoice form had no GST-rate field. Every line carried a **hidden 18**.

On save, `assertMayChargeGst` read that 18 for an entity that may not collect GST and refused —
*before* the tax mode or the export rule could zero it. The preview, meanwhile, showed
`GST — zero rated 0.00`, so the screen said one thing and the save said another. The error
told the person to "set the rate to 0", on a form with no such field.

**A personal account could not save a single invoice, overseas or domestic.**

The server's refusal was correct and is kept — `bill-of-supply.integration.test.ts` asserts
it — and so is s.32(1) behind it. The defect was a form sending a rate the person never typed.

`lib/invoice-lines.ts` now states the rule once: a line starts at 18 for an entity that may
charge GST and at 0 for one that may not, and for the latter **every line is sent at 0**
whatever it was opened with, so a draft saved under another rule cannot be stranded behind a
refusal with no field to answer it.

## 2. Everything else that spoke GST to a person in no return

| where | what it said | now |
|---|---|---|
| invoice form, banner | "Export · zero-rated", "Place of supply Outside India (96 – Other Country)", a LUT pill | "Bill of supply · no GST" |
| invoice form, totals | "GST — zero rated 0.00" | no GST row |
| invoice form, SAC | a red "Every invoice line needs a SAC code — it feeds the HSN/SAC summary in GSTR-1" | none; the field says "(optional)" |
| invoice page | "Export of services · zero-rated under LUT", a Place of supply pill | "Bill of supply · no GST" |
| invoice page | an **Amend** button — a GSTR-1 table 9A correction | hidden, **and the service refuses it** |
| the document | "Place of Supply: Outside India (96 – Other Country)", "Whether tax is payable under reverse charge: No", a "State: China" row under an address that already said China, a column of dashes where a SAC would be | "Supplied to: China", none of the rest |
| cancel hint | "a GST series may not have unexplained gaps" | "a numbered series should have no unexplained gaps" |

The preview route copies fields from the service **one at a time**, so the new `chargesGst`
never reached the form on the first try and the old export banner kept showing. Every test
passed; looking at the page found it. The field is passed through now, with a comment saying
why that list is not a spread.

The SAC complaint is suppressed only for a document that carries no tax. A registered
company's form is unchanged and a test pins it.

## 3. No bank account — the larger gap

Nothing in the application could create a `CompanyBankAccount`. The seed did, for Adpedia, and
`createCompany` makes only the ledger account a bank would map to. So the second entity had
none, and two things followed that no test or screen had met, because everything ran as the
company the seed built:

1. its invoices printed **—** under Payment details, so a client had nowhere to pay;
2. `createReceipt` read the default account with `findFirstOrThrow`, so **recording the money
   when it did arrive threw**, as a database "not found" rather than a sentence.

`addBankAccount` (Settings → Company) gives an entity somewhere for money to arrive:

- the **first** account is the default and prints on invoices, mapped to the 1010 the chart
  already carries and renamed to the account's own name;
- **later** ones each get their own ledger account (1011, 1012 … below 1050 Cash in Hand), so a
  statement reconciles against one balance and not a blend;
- there is only ever **one** default and **one** account that prints, because the receipt
  screen and the renderer each take exactly one;
- IFSC is optional (an overseas account has none) and validated when given; SWIFT is the same
  eight-or-eleven check as docs/87; a duplicate number is refused; the audit entry never holds
  the account number;
- the check is `assertCan` in the service, not on the screen.

Four services now ask `requireDefaultBank` and say "This entity has no bank account yet. Add
one in Settings → Company" — receipts, bill payments, TDS challans and payroll.

## 4. A label, not a value

"Proprietorship" is shown as **"Personal account"** everywhere a person reads it. The stored
value stays `PROPRIETORSHIP`: the chart (Proprietor's Capital and Drawings), the PAN-type
check, whose income-tax return it is, and whether the expense categories deduct TDS all key
off it. Renaming the value would rename none of those, only break them. The label lives in one
table, `lib/constitution.ts`, with a sweep that fails if a screen spells it out again.

## 5. A defect in docs/87, found on the way

The state dropdown listed Jammu & Kashmir (01) **after** Ladakh (38). `Object.entries` returns
integer-like keys ("10" … "38") before "01" … "09". It is now sorted by name, with a test.
The list was committed in `0211615` looking right in the source and wrong on the screen.

---

## 6. What this does not do

- **Vendor bills still carry the hidden 18.** *(Read from `bill.ts` and `rules/purchase.ts`, not exercised — no test posts a bill as an unregistered entity.)* `bills/new/form.tsx` has the same default, and
  `postBill` does not read the entity's registration, so a personal account booking a bill
  from a GST-registered vendor would debit **input GST (1210–1230) as a recoverable asset** —
  credit this entity has no right to, and which would understate its expense and so overstate
  its profit. `expense.ts` already refuses exactly that (s.16(1)); the bill path does not. It is
  a posting rule, not a form default, so it is recorded here and not changed in this module.
- **USD income is booked at face value in rupees.** The ledger entry for a USD 250 invoice
  reads ₹250.00. This is docs/84 §5 and docs/86 §6 again, and it matters most for exactly this
  entity: a personal account recording what a freelancer actually earned from overseas clients
  is the case where the rupee figure is the whole point. It needs an exchange-rate source and
  the CA's policy.
- **A USD bank account can be added but is booked in rupees,** for the same reason.
- **The document's terms are Adpedia's.** "Interest @18% p.a. applies on overdue amounts" is
  in the template for every entity; `Company.defaultTerms` exists and nothing binds it.
- **Credit and debit notes are still offered.** They are s.34 instruments; a personal account
  may well want to credit a client, so they are left, not hidden.
- **The company settings page** still carries GST rows (GSTIN, CIN) and links to the LUT
  register, e-invoicing and the compliance calendar. The server refuses those screens for an
  unregistered entity (docs/82); the links remain.
- **PAN stays required for a personal account.** Clients deduct TDS under it and the TDS
  credit (Form 26AS) is matched to it. The proprietor's own PAN belongs in Settings →
  Companies; it is not written into the repository.
