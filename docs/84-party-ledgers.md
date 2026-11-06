# 84 · A running account with every client, vendor and sub-contractor

docs/81 specified three ledgers and set the order to build them in. This is **step 3** —
the client and vendor ledgers, with the reconciliation that is the point of having them.

A sub-contractor needs no third thing: `vendorType: 'SUBCONTRACTOR'` is a vendor, the money
goes through 2000 Accounts Payable like any other, and the type is a label on the same
account. One ledger shape covers suppliers, freelancers and sub-contractors.

---

## 1. Read from the journal, not from the documents

Every report since docs/29 reads **journal lines**, and this is no different. `JournalLine`
carries `customerId` and `vendorId`, so a party ledger is one `WHERE` away and is, by
construction, the same money the trial balance sees.

🔴 Rebuilding it from the invoice and bill tables would be easier and would be wrong: it
would produce a statement that can disagree with the balance sheet, and then neither figure
is worth sending to anybody. docs/81 §3 measured the dimensions first — 1100 and 2000 both
tie exactly, with nothing unattributed — which is what makes this possible at all.

🔴 **The ordering is `accountLedger`'s, exactly: `[date, entryNo, id]`.** `JournalLine` has
no ordering column, so the two sides of one entry come back however Postgres feels, and a
running balance computed line by line differs between two exports of the same statement
(docs/58). A new query with its own `orderBy` is a vendor statement that disagrees with
itself.

## 2. What each ledger spans

**Client** — 1100 Accounts Receivable **and** 2400 Advances from Customers. docs/81 §6: a
client who has paid an advance owes less than their AR says, and a statement that shows only
AR asks them for money they have already sent.

**Vendor** — 2000 Accounts Payable. `postTdsDeduction` debits AP and credits 2210/2220/2230
as **its own journal entry**, so the deduction is a row rather than something netted into the
bill: ₹1,18,000 billed, ₹2,000 withheld under 194C, ₹1,16,000 payable — and ₹1,16,000 is what
the payment will be for. A figure taken from the bill table would say ₹1,18,000 and never
match.

The sign comes from the service, not the page: positive means *owed to us* on a client and
*owed by us* on a vendor, and the page prints those words beside the number. The same
component renders both, because a client statement and a vendor statement are the same
document the other way up and two copies of it would drift.

## 3. 🔴 The contra column — where the settlement went

`postReceipt` credits AR **once**, for cash plus the TDS the client withheld (`arCleared` is
built from both). So the ledger shows a single credit of ₹1,18,000 and nothing on the row
says ₹10,000 of it was never cash.

Each row therefore carries the other side of its own journal entry:

> Receipt ADPR/26-27/0001 · **Axis Bank ₹1,08,000 · TDS receivable 194J ₹10,000**

🔴 It is presentational and deliberately **not** part of the balance. Adding the 1310 debit
into the ledger would credit the client twice for one deduction — the TDS is already inside
the AR credit. Same for an invoice, where the contra reads *Software Development ₹1,00,000 ·
Output CGST ₹9,000 · Output SGST ₹9,000*, and for an advance, where it names the output tax
the advance declared.

## 4. 🔴 The reconciliation is the guard

docs/81 §6 asks for it by name: the sum of all client ledgers must equal 1100, and all vendor
ledgers 2000.

The figure that matters is **lines on a control account carrying no party**. A posting added
later that forgets `customerId` drops money out of every client ledger while the trial
balance still balances perfectly. Nothing fails, nothing warns, and the first symptom is a
statement sent to a client that is quietly short — docs/80's defect class, on the party side.

It is zero today, and the only thing that keeps it zero is something that looks. The test
asserts it, asserts the two sides agree, cross-checks the control figure against
`accountLedger('2000')` so that two identically-wrong computations cannot agree with each
other, and then **writes an orphan line onto AR and asserts the reconciliation reports it** —
without that, "unattributed is 0" could mean the query is broken rather than the books clean.

## 5. 🔴 What this found: the books hold dollars in a rupee account

A USD 6,500 invoice posts **6,500** into 1100 Accounts Receivable.

`Invoice.fxRate` is in the schema, defaults to 1 and is **read nowhere in the application** —
docs/67 §2's class, the same one docs/83 §7 hit in the month view. There is no conversion
anywhere: the dollars are carried as if they were rupees.

This is not a defect in the statement. It misstates the **trial balance, the balance sheet and
revenue** in exactly the same way, and it has done since exports were first billed. It is
listed in docs/00's blockers territory, not fixable here: the rate policy is a decision
(AS 11 / Ind AS 21 want the transaction-date rate, restated at the balance-sheet date with
the difference to the P&L), it needs a rate source, and it needs the CA.

🔴 So the ledger **says so** and refuses to present the total as rupees:

> **This balance mixes currencies.** 1 document in USD in FY 2026-27. A document raised in
> another currency is posted to the rupee control account at its own face value — no
> conversion is applied anywhere in this system — so the figures below add dollars to rupees.
> The same applies to the trial balance and the balance sheet. Treat this statement as a list
> of entries, not as a total, until a rate policy is agreed.

Inventing a rate at this end would have turned a wrong number into a confident one.

> **Since fixed — docs/91.** Invoices now carry a typed rate and post rupees; the warning above survives only for a document booked with no rate.

## 6. 🔴 And two numbers with the same name

The balance column went onto the customers and vendors lists as at **today**, while the
ledger it links to is a **financial-year** statement. On the dev books that read ₹3,54,000 in
the list and ₹4,22,000 in the ledger one click later, because an invoice dated later in the
open year counts in one and not the other.

Both were defensible, which is the problem — docs/56 §2's "two balances with the same name".
The column takes the ledger's own period now and its header says which: *Balance FY 2026-27*.

## 7. 🔴 A guard that could not see the class it was written for

docs/68 §5 added *no control is hidden on the mobile card*, because two controls had been
reachable only from a desktop-only table column. Its pattern knew about `<Button`, `<form`
and `onClick=` — and not about `<Link`.

Widening it to links turned up **two live instances**: the `edit` column on the vendors list
and on the projects list, both `mobile: false`, in tables that have **no `onRowHref` either**.
On a phone a vendor and a project simply could not be edited. Exactly the defect the guard
exists for, sitting under it the whole time, because a control that navigates is still a
control.

## 8. What is here

- `/customers/[id]/ledger` and `/vendors/[id]/ledger`, with a financial-year picker.
- A **Balance** / **Payable** column and a **Ledger** link on both lists, from one grouped
  query rather than one ledger per row.
- CSV for the CA through docs/36's existing route — `?report=client-ledger&party=<id>` — with
  docs/58's standing header, the contra column, and the party's name slugified into the
  filename, because a folder of `adpedia-client-ledger-2026-27.csv` is the problem that
  comment was already about one level up.

## 9. Left for later

- **PDF.** docs/81 §6 wants client and vendor statements as PDFs too, because those get sent
  to the party. The renderer exists (docs/33); the template does not.
- **The FX posting**, §5 — the largest thing on this page and the one that needs a decision
  rather than code.
- **Project statement** and the **untagged-cost queue**, docs/81 build order steps 1 and 2,
  still unbuilt. This was step 3, taken first because it was asked for.
