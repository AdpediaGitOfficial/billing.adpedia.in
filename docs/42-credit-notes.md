# 42 · Credit notes

**Status: done.** 485 tests (268 unit + 217 integration), typecheck and lint clean,
production build passes.

---

## 1. 🔴 A dead end the software itself pointed at

`cancelInvoice` refuses once money has arrived, with this message:

> Cannot cancel an invoice with receipts against it — **raise a credit note instead**

There was no way to raise one.

Worse: **GSTR-1 already built its `cdnr` table** from a `CreditNote` row that nothing could
create. The credit-note section of the return has been permanently empty — not because
Adpedia never issued one, but because the system could not.

Found by grepping error messages for the places where the software tells someone to do
something, then checking whether that something exists.

## 2. A credit note is not a cancellation

The distinction is the whole reason it exists, and the screen says so:

> ADP/26-27/0026 stays issued and stays reported. The credit note is its own document with
> its own number, reported separately in GSTR-1, that reduces what is owed. A tax invoice
> that has been acted on cannot be unsaid.

Its own series — `ADPC/26-27/0001` — allocated the same way invoice numbers are, under the
same Rule 46 constraints.

## 3. 🔴 The deadline in s.34(2)

A credit note reduces **output tax liability** only if it is issued by **30 November
following the end of the financial year of supply** (or the annual return date, if earlier).

After that the note is still perfectly valid between the parties — you can agree to charge
less, and the receivable drops — but **the GST already paid cannot be recovered.**

This is worth enforcing because nothing about the document looks different either way. The
shortfall only appears when the return is reconciled, months later.

### The trap in computing it

🔴 **A March supply is in the SAME financial year as the previous April.** A 15 March 2027
invoice is FY 2026-27, so its deadline is 30 November 2027 — the same as a May 2026 invoice,
not a year later. Reading the calendar year instead of the financial year hands out an extra
twelve months that does not exist. Tested at the boundary: 31 March and 1 April roll to
different deadlines.

The system does not block a late credit note — the commercial position may genuinely require
one. It states plainly what will and will not be recovered, and says to tell the CA.

## 4. What it posts

The invoice entry in reverse, for the credited portion only:

| | |
|---|---|
| Cr | 1100 Accounts Receivable — what the client owes drops |
| Dr | 4010 Revenue |
| Dr | 2110 / 2120 / 2130 Output GST — 🔴 **this is what reduces the liability**, and what s.34(2) governs |

An export credit carries no tax, because there was none to credit. The tax rate comes from
**the invoice as issued**, not from today's rate table — crediting part of an old invoice at
a new rate would leave the pair not netting out.

## 5. What it refuses

- **More than is left.** Partial credits accumulate; the second one knows about the first.
- **A draft.** Nothing has been issued, so there is nothing to credit — edit or cancel it.
- **A cancelled invoice.**
- **A reason under five characters.** It is reported in GSTR-1 and read by the client.

## 6. What it does not undo

🔴 **TDS the client already withheld.** A credit note does not reverse a deduction already
made and reported against your PAN. The excess surfaces in the 26AS reconciliation and is
settled against the next deduction. The preview says so rather than leaving it to be
discovered.

## 7. Still open

- **Credit notes have no PDF.** The renderer and template are invoice-shaped; a credit note
  needs its own document, which is a template job.
- **Debit notes** (s.34(3), increasing the value) are not built. Rarer, and the mirror image.
- **No credit-note list screen** — they are reachable from the invoice they credit, and they
  appear in GSTR-1.
- Carried forward: vendor and project edit pages, the unmatch button, payroll and challan
  cancellation.
