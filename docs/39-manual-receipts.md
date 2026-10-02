# 39 · Recording a receipt by hand

**Status: done.** 461 tests (263 unit + 198 integration), typecheck and lint clean,
production build passes.

---

## 1. 🔴 How this was found

Rather than pick from a wishlist, I surveyed for service functions with **no caller in the
UI or API** — capability that exists but is unreachable. Most hits were infrastructure
(`postJournal`, `rateAsOf`) called by other services, which is correct.

One was not: **`createReceipt` had no UI caller at all.**

Money could only be recorded against an invoice by matching a bank line. So a cheque, a cash
payment, or a payment you wanted to book ahead of the statement arriving had **no way in** —
on a screen called "Receipts" that until now only listed them.

## 2. 🔴 The move that makes the form usable

A client pays **net of TDS**, so the money that lands is short of the invoice by exactly the
tax they withheld.

Without help, someone recording that by hand types the amount that arrived, sees the invoice
still showing a balance, and then either **chases a payment the client cannot legally make**
or writes the shortfall off as a bad debt. Neither is right: the invoice *is* settled, and
the shortfall is a receivable from the government.

**Settle in full** fills both figures in. For a ₹1,41,600 invoice with ₹12,000 expected under
194J it proposes ₹1,29,600 cash plus ₹12,000 TDS — the same split the bank matcher proposes
for the same invoice.

### The arithmetic is shared, deliberately

It lives in `lib/settlement.ts`, not in the component, so the manual path and the automatic
one **cannot drift apart**. They are answering the same question.

🔴 It also clamps: **TDS can never exceed what is outstanding.** After a part payment the
remaining balance can be smaller than the tax expected on the whole invoice, and proposing
the full amount would over-allocate — which the service correctly refuses, with an error the
person has no way to act on. Six tests cover it, including that the parts always add back to
the whole.

## 3. What the form will not let you do

- **Over-allocate.** Shown per line as you type, and the submit button disables. The service
  refuses it independently; the form just explains it first.
- **Submit nothing.** An empty allocation is caught before the round trip.

It also says plainly what recording TDS *means* — that it is tax the client pays on your
behalf, claimable only once it reaches **Form 26AS** — because that is the step people miss.

## 4. Attachments, now visible

Phase 38 left upload and download working through the API with **no UI**. The bill screen now
has a panel: attach the vendor's invoice, download it, detach it.

🔴 Every link is a **download, never a preview**. The server refuses to serve anything inline,
so an `<img>` or an iframe pointed at one would simply fail — and the reason it refuses is
that a user-uploaded file rendering in this origin is exactly how stored XSS works. The panel
is built to match that rather than fight it.

The hint names why it matters: **Rule 36(1)** — input credit is claimable against a tax
invoice you hold.

## 5. Still open

- **The expense screens have no attachment panel yet** — only bills. Expenses get their
  receipt through the mobile capture flow, which already uploads.
- **Receipts cannot be cancelled or reversed from the UI.** A wrongly recorded receipt
  currently needs a correcting entry; `createReceipt` has no `cancelReceipt` sibling.
- ~~**Advance receipts** — money received before an invoice exists — still have no path.~~ Done
  in **`docs/54`**, where the interesting part turned out to be that GST falls due on an
  advance for services the moment it arrives. (Original note: The
  bank matcher can post one to 2400 Advance from customer; the manual form cannot, because it
  allocates against invoices only.
