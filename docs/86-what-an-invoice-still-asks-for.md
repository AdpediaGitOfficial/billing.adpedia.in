# 86 · What an invoice still asks for

A credit note credits 1100 Accounts Receivable. The trial balance knows. The balance sheet
knows. The client's running account knows — docs/84 reads journal lines, so it cannot not
know.

Nothing that computed *what is still owed on this invoice* knew. Eleven places took
`grandTotal`, subtracted `amountReceived` and `tdsCredited`, and stopped — nine found by
reading, and two more that only a sweep found, which were the two that write to a person.

So after a ₹23,600 credit note on a ₹1,18,000 invoice, the ledger said ₹94,400 and the ageing
said ₹1,18,000 — and `createReceipt` **accepted a payment of ₹1,18,000**, because its
over-allocation guard used the same arithmetic as the screen that offered it.

This module is not a fix to one line. It is the same subtraction, written out eleven times,
and what it took to make it stop being written again.

---

## 1. What was wrong, in order of what it cost

| | read the issued total | consequence |
|---|---|---|
| `receipt.ts` over-allocation guard | yes | **money banked that had been given back**, and the invoice marked PAID |
| `advance.ts` adjustment guard | yes | an advance absorbed into a debt already credited, pushing the client's 1100 negative |
| `chases.ts` overdue chase | yes, *and not even `tdsCredited`* | **the client is emailed and asked for it** |
| `notify/schedule.ts` | same | the daily reminder says the wrong figure |
| `receivables.ts` `arAgeing` | yes | AR total disagrees with 1100, for ever |
| `reports/ageing.ts` | yes | the second ageing report, wrong the same way |
| `banking/reconcile.ts` | yes | the right payment reads as a part payment; the invoice can never be closed from the bank screen |
| `invoice-months.ts` | yes | the month view disagrees with the Collectible tile beside it |
| `client-pnl.ts` | yes | phantom receivables per client |
| `receipts/new/page.tsx` | yes | **offers an amount the service should refuse** |
| `receipts/page.tsx` | yes | the advance-adjust list offers the same |

A debit note is the same defect mirrored: it debits 1100 for additional value, so **more** is
owed than the invoice says, and no ageing ever asked.

🔴 **Why it survived.** The error was symmetrical. A credit note posts a complete, balanced
journal entry, so the trial balance balances whether or not any report reads it. Nothing
reconciled the ageing against 1100 — docs/84 reconciled 1100 against the sum of the *party
ledgers*, which read the same journal lines, so two right figures agreed with each other
while eleven wrong ones agreed with each other somewhere else.

And `previewDebitNote` had the correct expression all along:

```ts
invoiceTotalAfter: new Decimal(inv.grandTotal.toString()).minus(credited).plus(debited).plus(grandTotal),
```

One line, in one preview, used by nothing else. The knowledge was in the repository; it was
not in the place that needed it.

---

## 2. One statement of it

`src/lib/invoice-open.ts`, in the shape of `lib/settlement.ts` — pure, so the arithmetic is
testable without a database, and shared, so the manual path, the bank matcher and the reports
cannot drift apart again.

```ts
invoiceOpen(invoice, notes) -> {
  issued,                       // the invoice as raised
  credited, debited,            // live notes, gross
  gross,                        // issued − credited + debited.  What 1100 carries.
  received, tdsCredited,
  outstanding,                  // gross − received − tdsCredited, floored at zero
  tdsExpected,                  // what the client will withhold, CAPPED at outstanding
  collectible,                  // outstanding − tdsExpected
  settled,                      // within the half-rupee tolerance used throughout
}
```

Note totals come from `noteTotals(companyId, invoiceIds)` — one `groupBy` for a whole list,
because the ageing runs over every open invoice and a lookup per row is what gets a report
taken out again. `cancelledAt: null`, matching what `credit-note.ts` has always done when
deciding how much of an invoice is left to credit.

🔴 **`tdsExpected` is capped, not scaled.** `tdsAmount` is the tax computed on the invoice as
issued; credit half of it away and the client will deduct on the reduced value, so the stored
figure is high. Scaling it pro rata would be inventing a tax position. Capping it at the debt
is the reasoning `settleInFull` already applies, and erring high understates what is
collectible — which under-chases rather than over-chases.

---

## 3. The guard, which found two more

The defect was never one wrong line, so a test of one line is no use. `tests/invoice-open.test.ts`
sweeps `src` for anything subtracting `amountReceived` from `grandTotal` outside the helper,
and for anything re-deriving the expected TDS by hand.

It found three sites the nine-place audit had missed:

- `chases.ts:269` — **the chase that goes to a client.** It subtracted `amountReceived` and
  nothing else: not the credit notes, and not even the TDS the client had already withheld.
  The letter asked for money that had been given back and for tax the client is legally
  required to pay to the government instead — the exact letter `receivables.ts`'s own comment
  says must never be sent.
- `notify/schedule.ts:72` — the same arithmetic for the daily push.
- `invoices/[id]/page.tsx:188` — the one screen that already netted the notes correctly, and
  the ninth hand-written copy. It now reads `open.gross`, so the sweep covers it too.

The sweep proves it can see the code before a clean run means anything: it asserts it found
over 200 source files and at least eight callers of `invoiceOpen`.

---

## 4. Two things found while looking, which are not about credit notes

### A receipt from one client, against another's invoice

```ts
customerId: input.customerId,   // never checked against the invoices it settles
```

The form only ever sends the chosen client's own invoices and the bank matcher builds both
sides off one invoice, so both happy paths agree and the service accepted any pairing. A
receipt recorded against the wrong client credits **their** receivable while another client's
invoice is marked paid — two running accounts wrong in opposite directions, so the trial
balance still balances and nothing says a word.

`createReceipt` now refuses, naming the invoice and the client it was raised to. Which also
closes the cross-company case for free: the invoices are scoped to `ctx.companyId` and must
belong to the receipt's client, so a `customerId` from another entity can no longer be stored.

### A server action that wrote without asking who was asking

`skipTxnAction` reached `prisma` directly. Every other action either calls a service that
begins with `assertCan` or asserts itself; this one took a signed-in session as the whole of
the check. An AUDITOR — who holds `banking` at `read` precisely so the books cannot be
touched — could mark a bank line IGNORED, and so could an EMPLOYEE, who has no banking
capability at all. An ignored line leaves the reconciliation queue and does not come back, so
money that arrived is never matched to an invoice and the client is chased for it.

`tests/route-authorisation.test.ts` already swept `src/app/api` for exactly this rule and
stopped at the API boundary. A server action is a POST endpoint with a generated name;
the sweep now covers those too, narrowly — an action that writes through `prisma` **itself**
must assert, because there is no service underneath it to do so. Verified by removing the
`assertCan` and watching the sweep name the function.

---

## 5. One more, fixed by inspection rather than by a test

`applyMatchAction(txnId, suggestionIndex, learn)` was right to re-derive the suggestion on the
server rather than accept it from the browser — nothing the client sends can invent an
allocation. But it identified the suggestion by its **position** in a list rebuilt at the
moment of the click, and that list depends on which invoices are still open. Match one line in
a statement and the next line's suggestions reorder underneath it: "accept the second one"
then posted a receipt against a different invoice from the one the person had just read,
silently, with nothing afterwards recording which it had been.

The action now also takes the `reason` string that was on screen — the suggestion in words,
amounts and invoice numbers and party — and refuses if it no longer matches, quoting what the
suggestion now says. This one is covered by reading the code, not by a test: a server action
needs a request context and there is no harness for one here.

---

## 6. What is still open

- **The FX posting, still.** A USD invoice books its face value into a rupee control account;
  `Invoice.fxRate` is read nowhere. `invoiceOpen` does not fix it and does not pretend to —
  the dollars are now netted correctly against dollar-denominated notes, which is as right as
  this layer can be while the posting is wrong. docs/84 §5 and the CA's rate policy.
- **Two ageing reports.** `receivables.ts` and `reports/ageing.ts` compute the same thing from
  the same table for different screens. Both now go through `invoiceOpen`, so they agree, but
  one of them should not exist.
- **No ageing-versus-1100 reconciliation.** docs/84 reconciles 1100 against the party ledgers.
  Nothing reconciles the *ageing* against 1100, which is why eleven places could disagree with
  it in silence. `tests/invoice-open.integration.test.ts` now cross-checks one client; the
  report-level guard is the real answer.

- **The payables side has the same structure and, today, no bug.** `payables.ts`,
  `reports/ageing.ts`, `payBill` and `bills/[id]/page.tsx` each write
  `grandTotal − tdsAmount − amountPaid` by hand. All four agree — because nothing has been
  added since that changes what a bill is worth. There is no vendor credit-note model, so
  there is nothing for them to be missing. Checked rather than assumed, and left alone: the
  day a note against a purchase is modelled, those four go wrong at once, and that is the day
  to extract them.

- **A reimbursement owed to a person sits in a vendor control account.** Found while looking
  for the payables version of this defect, and deliberately not fixed here, because it is a
  chart-of-accounts decision rather than an arithmetic one.

  `postExpense` credits **2000 Accounts Payable** when an expense was paid personally and is
  reimbursable, carrying whichever dimension it has — `employeeId` for a staff reimbursement.
  So:

  - `payablesAgeing` reads `VendorBill` and will never show it, while 2000 in the trial
    balance includes it. Two figures called payables, differing, with nothing saying why.
  - docs/84's vendor ledger is 2000 filtered by `vendorId`, so a line carrying only an
    `employeeId` is not in any party ledger — and `partyReconciliation` will therefore report
    it as **unattributed**, which docs/84 measured as zero. The first reimbursable staff
    expense will make that guard speak. That is the guard working: the figure is genuinely
    outside every vendor's running account.

  The real question is whether a reimbursement belongs in 2000 at all or wants its own
  liability account — which changes the balance sheet, so it is the CA's call, not a sweep's.
