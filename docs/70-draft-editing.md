# 70 · Editing a draft

**Status: done.** 932 tests (397 unit + 535 integration), typecheck and lint clean,
production build passes.

`docs/41 §5` left one line: *"Invoice drafts cannot be edited — a draft has to be cancelled
and re-raised. The numbering is safe either way, since a draft has no number."*

The numbering was safe. The habit was not: cancelling is the act this system reserves for
documents that have been **issued**, and performing it on a typo teaches that a cancellation
means nothing much. By `docs/51` there were six things that could be cancelled and each one
carried a real consequence; a seventh that meant "I mistyped the rate" devalues all of them.

---

## 1. What may be edited, and what the check asks

Everything a draft has — customer, project, date, reference, milestone, TDS section and the
lines. Nothing else, because nothing else exists yet: a draft carries no number, posts no
journal entry and has been shown to nobody.

🔴 **The check is the status, not the number.** `isDraftNumber` exists and would have been the
obvious thing to ask. It is a rendering detail: an invoice that was sent and then cancelled
still has a real number and must not be editable either, and a check on the number's shape
would have let it through.

## 2. 🔴 Everything is recomputed, not patched

Changing the customer changes the document. Tax mode, place of supply, currency and `docType`
all follow from who is being billed: a domestic draft re-pointed at a foreign client is an
**export invoice**, drawn from a different series and needing an LUT.

Copying the new `customerId` over the old one and leaving the rest would produce a draft that
is internally impossible — an IGST invoice addressed to a Kerala client, a rupee export — and
nothing downstream would question it, because every field would be individually well-formed.
So the service runs the same `loadCustomerAndMode` → `computeInvoice` → `computeInvoiceTds`
path that `createInvoice` runs, and writes the result.

## 3. 🔴 The financial year is re-resolved from the new date

This is the one that would have been missed.

A draft moved across 1 April keeps its old `financialYearId` under any patch-the-fields edit,
and `sendInvoice` takes its number from the series for **that** year. A draft dated April 2027
would be numbered out of the 2026-27 series: out of order, in a year it does not belong to,
and with a well-formed number from a real series — so nothing downstream notices. The gap only
appears when somebody reconciles the register, which is what `docs/64` exists to make possible
and which would then be reconciling against a number that should never have existed.

`assertPostable` is called on the new date and its answer is written to the row.

## 4. 🔴 The form must not adopt a default on arrival

The invoice form adopts the customer's usual TDS section when a customer is **picked**:

```ts
useEffect(() => { if (customer) setTdsSection(customer.defaultTdsSection ?? '') }, [customerId])
```

Opening a draft to fix a typo sets `customerId` from the draft, which fires that effect and
quietly replaces whatever section the draft was saved with by the customer's default. A TDS
change nobody made, on a document about to be sent, invisible unless somebody happened to be
looking at that field.

The guard is a ref consumed on the first run, rather than a change to the dependency list,
because the effect must still fire on a genuine re-pick of the same field.

## 5. One form, not two

`/invoices/[id]/edit` renders the same `InvoiceForm` as `/invoices/new`, with a `draft` prop
and a bound server action. A second form would be a second place for the SAC check, the
tax-mode preview, the `serviceItemId` binding (`docs/67`) and the live totals to drift apart —
and the whole reason this edit is safe is that it is the *same* computation as the create.

🔴 **The refusal is shown, not hidden.** Reaching `/edit` for an issued invoice is a stale link
or a typed URL, and `notFound()` would be a lie: it exists, and what it cannot be is edited.
The page says so, says why, and names what to do instead — a credit note, a debit note, or
cancel and re-raise.

## 6. Still open

- **A sent invoice's non-financial fields** — the customer reference and the milestone appear
  on the document and change nothing in the ledger. They are frozen anyway, because `docs/59`
  archives the bytes that went out and `docs/41` fixes the bill-to details at send: editing
  them would make the stored document and the record disagree, which is worse than a wrong PO
  number.
- **A draft has no history.** The audit log records each edit's before and after totals, and
  nothing surfaces that; it is one query away if it is ever wanted.
- Carried forward from `docs/00 §7`: user invitations, advance tax instalments and ROC filings
  on the calendar, opening balances at year-end close, IRN and QR on the invoice template, and
  server-side pagination on the three 100-row lists.
