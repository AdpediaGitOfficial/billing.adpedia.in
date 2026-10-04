# 41 · Editing master data

**Status: done.** 471 tests (263 unit + 208 integration), typecheck and lint clean,
production build passes.

---

## 1. 🔴 The bug that had to be fixed first

The obvious module here was "add edit screens" — **no entity had one**. Customers, vendors,
projects, invoices and bills were all create-only, so a wrong GSTIN or a typo in a billing
address could not be corrected at all.

Checking what an edit would actually *do* found something worse.

An invoice snapshots its `taxMode` and `placeOfSupply`, but **not the customer's name,
address or GSTIN** — the document rendered those by joining live to the `Customer` row. So
adding the obvious feature would have meant:

> correcting one typo in a customer's address **silently rewrites every invoice already
> issued to them**.

The copy the client holds and the copy we can reproduce would no longer match. That is a
Rule 46 problem — a tax invoice is a fixed document — and it is **exactly the defect found in
Adpedia's own historical invoices** in docs/03: VIII/308 on the paper, VIII/318 on the
register. Except self-inflicted, and silent.

It is also a GST problem. The buyer's GSTIN on the invoice is what was reported in GSTR-1 for
that period; change it later and the document disagrees with the filed return.

## 2. The fix: freeze the bill-to details at issue

Five columns on `Invoice` — `billToName`, `billToAddress`, `billToGstin`, `billToStateCode`,
`billToCountry` — written in `sendInvoice`, at the moment the number is allocated and the
document becomes real.

The renderer prefers the snapshot and falls back to the live customer **only for drafts**,
which is correct: nothing has been issued, so there is nothing to preserve.

Existing invoices were backfilled from the customer as it stands today. That is the honest
record: before the columns existed those invoices were *always* rendered live, so today's
customer row is precisely what they have been showing.

Two tests hold it:

- renaming a customer, changing their GSTIN and replacing their address leaves an **issued**
  invoice rendering exactly as before
- a **draft** still follows the live record

## 3. Then the edit screens

With the snapshot in place, editing is safe. The customer form is the create form with values
loaded, plus one thing it has to say:

> 2 invoices have been issued to this customer. Every issued invoice keeps the name, address
> and GSTIN it carried when it was sent, so nothing already with the client changes.

And when the state code, country or GSTIN is being changed, it says the treatment switches
**from the next invoice onward** — because that is the part someone would otherwise discover
by accident.

## 4. 🔴 The audit had to grow up

`updateCustomer` recorded only the name, before and after. But the field that matters is the
**state code** — change it and every future invoice switches between CGST+SGST and IGST. The
audit now records country, state code, GSTIN and the billing address on both sides, because
"who changed it, when, and from what" is the only way to explain a period where the treatment
switched.

Same for vendors, where **PAN and the foreign-supplier flag** decide the TDS rate and whether
reverse charge applies.

## 5. Still open

- **Vendor and project edit screens.** The services (`updateVendor`) and the audit are done;
  only the pages are missing, and they follow the customer pattern exactly.
- ~~**Invoice drafts cannot be edited**~~ — done in `docs/70`. The numbering was safe either
  way; the habit was not, since cancelling is what this system reserves for documents that
  have been issued.
- **Unmatching a bank line** still has a service and no button (carried from docs/40).
- **Payroll runs and TDS challans** still cannot be cancelled (carried from docs/40).
