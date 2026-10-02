# 54 · Advances

**Status: done.** 675 tests (314 unit + 361 integration), typecheck and lint clean,
production build passes.

Money in before an invoice exists. It had no path since docs/39, and the reason it is not
simply "a receipt with nothing allocated" is that **tax falls due the moment it arrives**.

---

## 1. 🔴 GST is payable on an advance for services

The one almost everybody gets wrong, because the rule changed for goods and not for services.

s.13(2) fixes the time of supply for services as the earlier of the invoice date or the date
of receipt of payment. **Notification 66/2017** relieved suppliers of *goods* from paying tax
on advances — and left services exactly where they were. Adpedia supplies services, so an
advance received today is a liability declared in today's return, months before the invoice.

What is issued is a **receipt voucher** under s.31(3)(d), not a tax invoice. The invoice
follows when the supply is made.

### The money arrives tax-inclusive

🔴 A customer pays a sum of money, not a taxable value plus tax. Rule 50 deems the advance to
include the tax, so ₹1,18,000 received at 18% is ₹1,00,000 of taxable value and ₹18,000 of
tax **backed out** of it — never ₹1,18,000 with ₹21,240 added on top. The screen shows the
split before anything is saved, because it is the figure people expect to be wrong.

### It is a liability, not revenue

`2400 Advances from Customers` carries the taxable value and the output-tax accounts carry the
tax. Nothing touches revenue: nothing has been supplied yet.

## 2. 🔴 Rule 50, where you do not know yet

Two halves, and the second is counter-intuitive:

| | |
|---|---|
| The **rate** cannot be determined | pay at **18%** |
| The **nature of supply** cannot be determined | treat as **inter-state** |

An unknown place of supply is IGST, not CGST+SGST — because IGST can be reapportioned between
the states afterwards and CGST+SGST cannot. The screen says so when the customer has no state
on file.

## 3. 🔴 Absorbing it reverses the head that was actually charged

When the invoice finally covers the advance, the tax the advance paid is reversed, because the
invoice declares its own. Leaving it would tax the same supply twice — which is exactly what
GSTR-1's table 11B exists to prevent on the return side, so the books have to do the same
thing or they stop agreeing with it.

🔴 And the reversal is read back **from the ledger, head by head**, not computed from the
invoice:

> An advance whose place of supply was unknown was charged **IGST** under rule 50. The customer
> turns out to be in Kerala, so the invoice is intra-state and carries **CGST + SGST**.
> Debiting the invoice's heads would reverse tax out of accounts that were never credited and
> leave the IGST sitting there for ever.

A test drives exactly that: IGST on the advance, CGST+SGST on the invoice, and both ending
where they should.

## 4. The return

- **11A** — advances received on which tax is payable, at the rate each was actually charged
  (derived from its own posting, not assumed).
- **11B** — advances adjusted against invoices raised in the period, read from the adjustment
  postings themselves.

Both are in the CSV the CA files from, and 11A carries a warning naming Notification 66/2017,
because the first question anyone asks is why there is tax on an advance at all.

## 5. TDS on an advance

A client who deducts on an advance is right to: the deduction follows the **payment**, not the
invoice. It is booked as receivable against the customer with no invoice to hang it on — which
is the one thing `TdsReceivable` had never had to cope with — and it appears in that quarter's
26AS like any other.

## 6. What rendering found

- The 🔴 marker had leaked into a field hint again, the thing docs/50 §5 cleaned up.
- The live preview printed **₹118000.00** rather than ₹1,18,000.00 — every other screen uses
  Indian grouping.
- 🔴 The adjust control offered an invoice with **₹0.00 open**, which the service would have
  refused. Status alone was the wrong filter: an invoice settled by a receipt can still read
  `PARTIALLY_PAID`.

## 7. Still open

- **Refund vouchers** (s.31(3)(e)) — where an advance is returned and no supply is made.
  Rarer, and it wants the same care as this did.
- **The receipt voucher has no document.** It is recorded and reported; nothing prints it for
  the client, though rule 49 fixes its contents much as rule 53(1A) fixes a credit note's.
- **An advance cannot be cancelled** from the UI. `cancelReceipt` handles a receipt with
  allocations; an advance with tax posted against it needs the docs/51 treatment.
- Carried forward: Form 16/16A, portal reconciliation, payslip documents, statement PDFs,
  journal export, service-item CRUD, the mobile tail, chases.
