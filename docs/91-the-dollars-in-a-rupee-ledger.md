# 91 · The dollars in a rupee ledger

A USD 250 invoice posted **₹250** into 1100 Accounts Receivable and into income.

`Invoice.fxRate` has been in the schema since the first export. It defaults to 1 and was read
nowhere. docs/84 §5 found it, docs/86 §6 repeated it, docs/88 §6 said it hurt the personal
account most — whose whole purpose is to record what a freelancer earned from overseas
clients, in rupees. Every one of them named it and declined to fix it, because the fix needs a
rate policy. This module makes one and applies it.

---

## 1. The policy, and what is assumed

Ind AS 21 / AS 11: a foreign-currency transaction is recorded at the rate on the date of the
transaction; settling it at a different rate is a **realised** forex gain or loss.

- **The rate is typed, not fetched.** There is no rate source in this system and a rate
  invented here would turn a wrong number into a confident one. It is rupees per one unit of
  the invoice currency, on the invoice date — the RBI reference rate or the bank's, the person
  entering it decides.
- **The document stays in its own currency.** The invoice the client holds says USD 250; only
  the ledger is in rupees. `invoiceOpen`, the over-allocation guard and every per-invoice
  screen keep working in the invoice's currency.
- **The default of 1 means "not entered"** for a foreign document, because no foreign
  currency trades at exactly one rupee (`rateIsSet`). A rupee invoice needs no rate.

🔴 Assumed, and for the CA to confirm: the **same rate** is used for the books and for the GST
value reported in GSTR-1. Rule 34 of the CGST Rules asks for the exchange rate *notified by the
CBIC* at the time of supply for the GST value. If the books use the RBI rate, GSTR-1 and the
books can differ by the gap between the two.

## 2. What posts

| | before | now |
|---|---|---|
| Invoice, USD 250 at 84.50 | Dr 1100 250 · Cr 4010 250 | Dr 1100 **21,125** · Cr 4010 **21,125** |
| Credit / debit note | face value | at the **invoice's** rate, not today's — the receivable being reduced was carried at that rate |
| Receipt | a typed `fxGainLoss` | rupees credited are typed; the gain or loss is **derived** |
| GST amendment, note amendment | face value | the delta, converted at the invoice's rate |

`postInvoice` converts every line and makes receivables the **sum of the converted parts**, so
the entry balances to the paisa whatever the rounding does. The notes do the same.

### The receipt

The person enters the **rupees the bank credited** (the statement, or the FIRC). Then:

```
forex = rupees credited + bank charge − rupees of receivable cleared (at the INVOICE's rate)
```

positive is a gain (4920), negative a loss (5900). USD 250 booked at 84.25 (₹21,062.50) and
paid as ₹20,900 posts Dr bank 20,900, Dr Forex Loss 162.50, Cr 1100 21,062.50.

🔴 **Cumulative, not per receipt.** The receivable cleared is
`toInr(received so far + this payment) − toInr(received so far)`. Rounding each part separately
can leave a paisa in 1100 when the last payment closes the invoice; differencing the running
total means the parts always add up to exactly the rupee value of the whole. Two part-payments
at different rates clear 1100 to ₹0.00 — a test.

Refused: a typed forex figure on a foreign receipt; Indian TDS on one (an overseas client does
not deduct it); two currencies on one receipt; rupees credited on a rupee receipt; a foreign
receipt with no rupee figure.

A foreign invoice **cannot be sent without a rate** — the number is only allocated after.

## 3. What reads it

Anything that adds invoices into a rupee figure now goes through `inrOf` (`lib/fx.ts`):
the receivables total and ageing, the second ageing report, a client's outstanding, the
month view, the dashboard (revenue, invoiced, collected, the monthly chart, revenue by client),
GSTR-3B 3.1, and the GSTR-1 export, HSN and totals tables. The GSTR-1 CSV headers now say
`(INR)`.

The receivables total agrees with 1100 — a test, with a rupee invoice and a USD one open.

The chase email and the overdue-invoice subject read "USD 250.00 outstanding", not ₹250. They
printed every invoice with the rupee sign.

🔴 **The sweep** (`tests/fx.test.ts`). It forbids a database-side `_sum` over invoices — a sum
cannot apply each invoice's own rate — and requires every file that does `invoice.findMany` to
import `lib/fx` or be named in a list with the reason it does not add amounts up. A new report
that reads invoices and adds `grandTotal` fails it. Verified by removing the import from one
reader.

## 4. What it refuses instead of guessing

- **An advance against a foreign invoice.** An advance is held in rupees; adjusting it against
  dollars of receivable has no rate to say how many. Record the payment as a receipt on the
  invoice instead.
- **The bank matcher no longer offers a foreign invoice.** A bank line is in rupees, and
  comparing ₹20,900 with 250 produced nonsense suggestions. A foreign payment is a receipt with
  the rupees typed in.

## 5. What is still open

- **Invoices sent before this change are still booked at face value.** Their rate is 1 and the
  statement still warns about them ("booked with no exchange rate"); the month view names them
  rather than adding them. Re-booking one means cancelling it and issuing it again at a rate —
  there is no correcting entry yet. Any receipt already recorded against such an invoice makes
  that harder. **Nothing in the development database matters here; the live box may hold some.**
- **No revaluation at the balance-sheet date.** Ind AS 21 restates open foreign-currency
  receivables at the closing rate and takes the difference to the P&L (unrealised). Only
  realised differences are booked, at receipt.
- **A foreign advance.** Booked as a rupee receipt and not adjustable against a foreign
  invoice (§4); a USD bank account is still booked at its rupee value.
- **Vendor bills in a foreign currency.** `VendorBill.currency`/`fxRate` are still unused: a
  bill from a foreign vendor is entered in rupees and always was. Income was asked for; this is
  the mirror image and is not done.
- **Credit notes against a part-paid foreign invoice** round separately from receipts, so a
  paisa of difference is possible when both are used on one invoice.
- **Rule 34** — see §1.
