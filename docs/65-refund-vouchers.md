# 65 · Giving an advance back

**Status: done.** 880 tests (382 unit + 498 integration), typecheck and lint clean,
production build passes.

docs/54 established the hard part: GST falls due on an advance for services the moment the
money arrives — s.13(2), with Notification 66/2017 relieving goods and not services. It left
one thing open, and it is the thing that costs money: **what happens when the supply never
happens and the advance goes back.**

By then the company has already declared, and very likely paid, tax on a supply that did not
occur. Without this document and the adjustment behind it, that money is simply gone.

---

## 1. 🔴 A refund voucher is not a credit note

This is the mistake the module exists to prevent, and it is an easy one: there is money going
back to a customer, so the hand reaches for s.34.

s.34 credits an **invoice**. Here there is no invoice — that is the whole point of a refunded
advance. s.31(3)(e) provides a document of its own and rule 51 fixes its contents, including
one field a credit note has no equivalent of: 🔴 **the number and date of the receipt voucher
being refunded against**. Without it the recipient cannot tie the two together, and nor can
anybody reading the return.

The voucher says so on its face, in its own declarations: *"This is not a credit note: section
34 applies to an invoice, and no invoice was issued."*

## 2. 🔴 The tax comes back out of the heads it went into

The same rule as docs/54 §3, for the same reason. An advance whose place of supply was unknown
was charged **IGST** under rule 50; refunding it against CGST and SGST would take tax out of
accounts that were never credited and leave the IGST sitting there for ever. So the split is
read back from what was actually posted, pro rata to the amount going back.

And the refund is tax-inclusive because the receipt was: of ₹59,000 returned, ₹9,000 is the tax
declared when it arrived. A part refund takes a proportional slice, head by head.

## 3. What it refuses

- **No reason, no voucher.** Rule 51(f) puts it on the document, and so does anybody looking
  at this in two years.
- **More than is left.** An advance part-adjusted against an invoice and part-refunded can
  only give back the remainder, and the message says which happened to the rest.
- **A date before the advance arrived.**

## 4. 🔴 Table 11B, with a question for the CA

A refunded advance has to come out of the liability declared in 11A of an earlier period, and
table 11B — *adjustment of advances* — is where the return does that. It gets its own block in
the CSV so the CA can see which rows are adjustments against invoices and which are refunds.

⚠️ The portal does not use the word *refund* anywhere in table 11, and some advisers amend
11A of the original period instead. The warning on the return says so rather than pretending
the presentation is settled.

## 5. One template, two vouchers

Rule 49 (receipt voucher) and rule 51 (refund voucher) prescribe nearly the same document, so
one template serves both — the same reasoning as docs/48, where one template served credit and
debit notes. docs/54 §7 had left the receipt voucher with no document at all; it has one now.

### What rendering them found

- 🔴 The payment mode printed as **`neft`**. The enum is upper case and lower-casing it for
  display put that on a document going to a client. Four of the nine modes are acronyms that
  read as a typo in lower case, and the rest read as shouting in upper — so a three-line map
  settles it.
- 🔴 The fourth cell of the meta strip carried **two labels and two values** — rule 51(c)'s
  receipt-voucher reference stacked above the payment mode — and wrapped onto four lines in a
  quarter of the strip. A refund's cell is the reference, because that is the field the rule
  requires; a receipt's is the mode.
- The receipt voucher repeated its own line description under a second heading reading
  *"Particulars"*, directly below a table column headed *"Particulars"*. The block is dropped
  where there is nothing distinct to say; a refund keeps it, because rule 51(f)'s reason is
  not the description.

## 6. 🔴 What it found in code already shipped

**`openAdvances` did not subtract refunds.** It had no reason to before today — but the moment
refunds existed, a fully refunded advance stayed "open": the screen offered to adjust money
that had already gone back to the client, and the service would have allowed it, taking output
tax out of the same accounts twice.

**A new document type needs its series on databases that already exist.** `allocateNumber`
refuses with *"No REFUND_VOUCHER series for FY … — create it in Settings first"*, and there is
no Settings screen that creates one. The seed only runs on a fresh install, so the migration
creates the row for every financial year already on file.

🔴 And that backfill had to be **its own migration**. Postgres refuses to *use* a new enum
value in the transaction that added it — *"unsafe use of new value of enum type"* — and Prisma
runs each migration file in one transaction. The `ALTER TYPE` and the `INSERT` that references
it are two files, in order.

**The test suite needed a longer timeout, and saying so.** Since docs/59 every `sendInvoice`
renders the issued document, which takes roughly 700ms; a test sending three or four invoices
sits near vitest's 5s default and tipped over under load, in a test about cancelling receipts
that has nothing to do with any of this. Raised to 20s with the reason written down, because a
suite that fails intermittently on timing is one people learn to re-run instead of read.

## 7. Still open

- **A refund voucher cannot be cancelled** from the UI. It is modelled for it —
  `cancelledAt` and `cancelReason` are there, and the return already excludes cancelled ones —
  but there is no `cancelRefundVoucher` to go with docs/51's family.
- **The receipt voucher is not archived at issue**, only on first download, because an advance
  has no separate issuing step. That matches the payslip in docs/59 and is worth revisiting if
  receipt vouchers are ever emailed automatically.
- **Nothing refunds a part of an advance in a foreign currency.** Advances are rupee-only
  today, so the question has not arisen.
- Carried forward: service-item CRUD, note amendments (table 9C), swipe gestures and the
  performance budget.
