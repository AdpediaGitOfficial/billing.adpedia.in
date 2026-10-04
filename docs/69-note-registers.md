# 69 · The documents nothing listed, and the cancellation nothing could reach

**Status: done.** 925 tests (397 unit + 528 integration), typecheck and lint clean,
production build passes.

Three documents this company issues under their own series had no register: credit notes,
debit notes and refund vouchers. Building one found that the refund voucher's journal entry
had been filed under somebody else's identity since `docs/65`, which is why `docs/65 §7`'s
missing `cancelRefundVoucher` could not have been written.

---

## 1. 🔴 A document's postings belong to the document

`createRefundVoucher` posted its journal entry as:

```ts
sourceType: 'RECEIPT', sourceId: receipt.id
```

— the **advance**, not the voucher, because `SourceType` had no member of its own. Two things
followed, and neither leaves a mark anybody would notice.

**`cancelReceipt` reverses every entry filed under the receipt's id.** So cancelling an
advance that had been refunded also reversed the refund: the money went back into the bank and
the liability back into `2400`, while the `RefundVoucher` row stayed live with `cancelledAt`
null and kept being reported in GSTR-1 table 11B. The books said the refund never happened and
the return said it did, and nothing anywhere recorded the disagreement.

**And nothing could find a voucher's entry**, so the cancellation `docs/65 §7` left open was
not merely unwritten — it was unwritable. A feature that cannot be built is usually a model
that is wrong somewhere else.

`SourceType` has a `REFUND_VOUCHER` member now, in two migration files because Postgres
refuses to use a new enum value in the transaction that added it (`docs/65 §6`, again), with
the second file re-filing the entries that already exist. They are matched on the narration,
which has always been written as `Refund voucher {number} — …` and whose number is unique per
company.

## 2. 🔴 An advance that has been refunded cannot be cancelled

The fix is not to reverse the refund more carefully. A refund voucher carries a number from
its own series, it went to the customer under rule 51, and it is in the return — cancelling
the receipt behind it would leave it refunding an advance the books say never arrived.

So `cancelReceipt` refuses, and names the voucher. Cancel that first, then the receipt. The
order is the only one in which both documents stay true.

## 3. 🔴 The refusal has to give its own reason

`cancelRefundVoucher` is refused once the GSTR-1 that declared it is filed — like a credit
note, and **not for the credit note's reason**.

A credit note sits in table 9B, reaches the customer's GSTR-2B and reduces the input credit
they may claim; that is why `docs/51` refuses it, and the message says so. A refund voucher
sits in **11B**, which is an adjustment of the supplier's own advances and has no counterpart
on the recipient's side at all. What filing it does is tell the government that tax declared
in an earlier period has been taken back; withdrawing it here would put the liability back
into a period whose return is closed, with nothing in any return to say so.

The remedy is the same shape — report it in a later return — but "the customer is holding a
reversal" would be untrue, and a refusal that gives the wrong reason sends somebody to fix the
wrong thing. `docs/61 §2`'s lesson, in a different place.

Nothing else needs putting back when a voucher is cancelled: the advance's available balance
is **derived** — `advanceAvailable` counts only refunds with `cancelledAt: null` — so there is
no stored figure to drift.

## 4. The registers

- **`/notes`** — credit and debit notes together. One list, because they are the same document
  in the law's shape taken in opposite directions, and what somebody comes here to see is the
  pair: how much has been credited away against how much has been charged back. `docs/48 §5`
  noted the gap; `listCreditNotes` had been sitting there with **no caller at all, not even a
  test**, for twenty-seven modules — `docs/49`'s class again.
- **Refund vouchers**, on `/receipts` rather than beside the notes. A refund voucher refunds a
  *receipt*; s.31(3)(e) gives it its own document precisely because there is no invoice to
  credit, and filing it with the notes would repeat the mistake the document exists to
  prevent. `listRefundVouchers` had tests and no caller.

Each note still belongs to its invoice, which is where it is raised, amended and cancelled.
These are registers — the series as a series, which `/settings/series` only ever showed the
*numbering* of.

### What the register says that the invoice cannot

- **GST not recovered.** A credit note raised past the s.34(2) deadline credits the client the
  same gross and recovers no tax (`docs/48 §1`). Per invoice it is a footnote; across the
  series it is a figure, and it is the only one on the page that is a loss rather than a
  movement.
- **Credited away against charged back**, with the asymmetry named: s.34(2) time-bars the
  credit note and nothing bars the debit note, because s.34 bars only the relief that reduces
  the government's tax.

## 5. 🔴 The rule, not a worked example

The first version ended with a footnote that picked one note and printed its deadline: *"…was
raised on 2026-05-10, so its credit notes may adjust GST until 2027-11-30."* True of that
invoice, and read as the deadline — which is the one thing the rule is not, since every
invoice has its own.

It states the rule now, and the **invoice's own date** is a column on every row: that is what
the s.34(2) clock runs from, and it is what comes apart from the note's date whenever a note
is raised in a later year (`docs/66 §1`).

🔴 It was a suffix on the customer's name first. On a phone the name ate the width and
truncated away the only part of the line that carried the rule — `docs/68 §7`'s
`₹7,43,40…` in a different column. It is a column of its own, on the card as well as the
table.

## 6. Two things the screen showed

- **`adjustrefund it`** — the advance row's two controls sat side by side with no gap and read
  as one word. It has been that way since `docs/65`.
- **"1 receipts"**.

Neither is a defect a test would ever have found, and both were visible the moment the page
was rendered and looked at.

## 7. Still open

- **A refund voucher has no detail page**, and neither does a note. Both are reachable from the
  document they adjust, which is where they belong; the registers link back to it.
- **Nothing emails a note or a voucher.** Both render on demand and both are archived at issue
  (`docs/59`), but sending one is still a person attaching a PDF.
- Carried forward from `docs/00 §7`: invoice draft editing, user invitations, advance tax
  instalments and ROC filings on the calendar, opening balances at year-end close, IRN and QR
  on the invoice template, and server-side pagination on the three 100-row lists.
