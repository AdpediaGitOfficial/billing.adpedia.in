# 92 · Booking an old invoice at its rate

docs/91 made every new foreign invoice post rupees. It could not touch the ones already
issued: they carry a number, they are in a GSTR-1 if the entity files one, the client holds the
PDF, and their ledger entry holds the dollars as if they were rupees. Cancelling and re-issuing
each one burns a number in a series that should have no unexplained gaps — and was never
possible once a receipt was against it.

What is wrong with them is only the **ledger**, so that is all this changes.

## 1. What it does

`Invoices → the invoice → Book at a rate` (or `Invoices → Review` for every one at once).

1. You enter the exchange rate and, optionally, the date of the correction.
2. The page **shows** the correction — each head, what is booked, what it should be, and the
   difference — and posts nothing.
3. A second button posts it: one new journal entry of type `FX_REBOOK` carrying only the
   difference, and the rate on the invoice. The invoice, its number and its issued document are
   untouched.

For USD 250 booked as ₹250 and re-booked at 84.25: Dr 1100 ₹20,812.50, Cr 4010 ₹20,812.50.
Receivables go from ₹250 to ₹21,062.50 and the invoice reads "Booked at ₹84.2500 per USD".

🔴 The correction is read back from **what was posted**, not recomputed from the invoice. What an
invoice posted to is not always what it would post to today (rule 50, GST amendments), and what
is corrected is what is there. Each head other than receivables is converted on its own;
receivables is what balances them, which is how `postInvoice` builds the entry.

## 2. What stands in the way

It refuses, naming each, while any of these exists:

- **A receipt recorded against the invoice.** It was posted at face value and cleared a
  receivable that is about to change by a factor of eighty. Cancel it first (it has its own
  reversal), re-book, then record the payment again with the **rupees the bank credited** — the
  figure the original never captured.
- **A credit or debit note, or a GSTR-1 amendment**, for the same reason.
- A draft, a cancelled invoice, a rupee invoice, one that already has a rate, a rate of 1.
- A correction dated in a **locked period** — with the lock's own message. Dated later, it is
  allowed, and the preview says the revenue difference then lands in that later period.

And the reverse, so the problem stops growing: a receipt, a credit note or a debit note
**against a foreign invoice with no rate is refused**, telling the person to book it at a rate
first. Before this a receipt against one posted a meaningless forex figure and then blocked the
correction.

The same permission as cancelling an invoice (`invoices.cancel`, approve) — an owner or an
accountant, not an auditor.

## 3. Cancelling a re-booked invoice

🔴 `cancelInvoice` reversed `findFirst(sourceType: INVOICE)`. The correction is a second entry,
so it would have been left standing alone: ₹20,812.50 of receivables and income for an invoice
that no longer exists. It now reverses every live entry of the invoice — its own and any
`FX_REBOOK` — and a test checks that nothing is left in either account. Verified by
reverting it.

`FX_REBOOK` is its own source type (migration `20261106150000`) rather than a second `INVOICE`
entry for exactly that reason: the cancel and the invoice page can tell the correction from
the document's own posting.

## 4. What it does not do

- **It does not touch a filed return.** If GSTR-1 for the invoice's period was filed with this
  export at its dollar figure, the preview says so. The books are right after this; the return
  has to be amended, and that is the CA's.
- **It re-books at one rate, once.** An invoice already at a rate is not re-rated; that would be a
  different correction (a revaluation) and is not built.
- **It does not guess the rate.** Same as docs/91: it is typed.
- **A receipt recorded before this, against such an invoice, is not auto-corrected.** It is
  named and the person is told what to do (§2) — adjusting a payment that already cleared the
  wrong receivable is a judgement about which figure the bank really credited.
