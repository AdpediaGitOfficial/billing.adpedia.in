# 81 · Project money and party ledgers — SPEC

**Status: agreed, not built.** Every other doc in this range describes work that is done.
This one describes work that is specified and has not started, so that the decisions behind
it are on record before any of it is written.

The requirement, in the client's words: *how much do I get from each project with GST and
without GST · sometimes we pay without GST · how much GST payable and receivable · each
project and each vendor and each client, I should get a clear ledger.*

---

## 1. The four decisions this is built on

Settled 30 Oct 2026. They are not re-opened by the implementation.

| | |
|---|---|
| **Contract value is always ex-GST** | No inclusive variant exists, so no flag distinguishes them. The convention is now stated on the form, the column header and the progress bar — a figure entered inclusive understates billed-against-contract by 18% for ever, silently. |
| **Direct margin only** | Costs booked to the project. No overhead apportionment: every apportionment basis is an argument with the CA, and none of them is a fact. |
| **Non-recoverable tax is two lines** | Blocked GST (s.17(5)) and cost with no GST at all are shown separately — §4 is why. |
| **Project-to-date** | Life of project is the default; the financial-year view is retained as a toggle, because the CA works in years and the client does not. |

And the requirement that constrains all of them: **everything must be traceable per project,
per vendor and per client.** §7 is why that is a process and not a field.

## 2. 🔴 The rule the whole report hangs on

**GST is a pass-through, so "how much do I get" has three answers**, and they must never be
collapsed into one:

| | Divine Ragas, as at 30 Oct 2026 |
|---|---|
| **Billed** (incl GST) — what the client owes | ₹1,18,000 |
| **Earned** (ex GST) — what is actually yours, and the only basis for margin | ₹1,00,000 |
| **Collected** — what reaches the bank, after the client's TDS | ₹1,00,000 − TDS + GST |

TDS is deducted on the taxable value, not on the tax, so a ₹1,18,000 invoice under 194J
banks ₹1,08,000 and leaves ₹10,000 as a 26AS credit. A report that shows one number and
calls it revenue is wrong twice over.

🔴 **Per-project tax is only ever *charged* and *booked*, never *payable*.** Set-off is
head-wise and company-wide — CGST credit may not discharge SGST, and IGST must be exhausted
first (s.49(5)(e)–(f), rule 88A, `docs/46`). A per-project "GST payable" column would be
fiction. The net cash figure is a company figure, and belongs on the GST screens.

## 3. What is already true

Established by reading the code and querying the books on 30 Oct 2026, so the spec does not
rebuild what exists:

- `JournalLine` carries `projectId`, `customerId`, `vendorId` and `employeeId`. Reports read
  journal lines, so every figure below is one `GROUP BY` away.
- `postInvoice` stamps the project on **all** its lines, tax included. After `docs/80`'s
  companion fix so do credit notes, debit notes and both amendment paths — before it, a
  project's output GST could rise and never fall.
- 🔴 The **advance pair is deliberately untagged**. An advance is received before any invoice
  exists, so its GST is booked with no project to book it against, and the absorption
  reverses that same untagged tax. Tagging only the second half would subtract tax from a
  project that was never credited with it. `tests/project-dimension.integration.test.ts`
  exempts it, with the reason.
- **The party dimensions tie exactly.** 1100 AR: 5 lines, ₹7,43,400, **zero** without a
  customer. 2000 AP: 9 lines, ₹3,10,000, **zero** without a vendor. So per-party ledgers will
  reconcile to the balance sheet with nothing left over.
- **The project dimension does not.** ₹72,000 of cost is on projects and ₹15,13,000 is not —
  and every rupee that reached a project got there through a payroll allocation. Not one
  expense or vendor bill has ever been tagged, though all three entry forms offer the picker.
  The mechanism works; the coverage is about 5%.

## 4. 🔴 Why "no GST" is its own line

Merged into one "non-recoverable tax" figure, these two look identical. They are different
problems:

- **Blocked credit (s.17(5))** — food, cabs, out-of-state hotels. A tax rule. Nothing to do
  but book the tax as cost, which `postVendorBill` already does, folding it proportionally
  across the split.
- **No GST at all** — an unregistered supplier, a composition dealer, an exempt supply. The
  cost is simply the amount paid… *unless* it is one of the s.9(3) categories, where **the
  liability is yours**: a goods transport agency, an advocate's fee, sponsorship, security
  services. Handover §2 records that this has never been put to the CA, and `docs/63 §3`
  that nothing in this system can produce such a document.

So the no-GST line carries a **flag, not a zero** — it is the only place in the books where
a cost might be hiding a tax the company owes. A combined line could not say that.

## 5. The project statement

Not a ledger. A project has no control account, so no single balance belongs to it; what it
has is every tagged line across revenue, cost and tax. Presented with a running balance,
readers take the last number for something owed.

**Billing**
| Figure | Source |
|---|---|
| Contract value (ex GST) | `Project.contractValue` |
| Billed, ex GST | income accounts, project-to-date |
| Billed, incl GST | + output tax lines |
| % of contract billed | ex-GST ÷ ex-GST, both sides |
| Unbilled contract balance | contract − billed ex-GST |

🔴 The GST on the unbilled balance is **not** shown as a receivable. It does not exist until
each invoice is raised. Divine Ragas: ₹7,00,000 unbilled, and the ₹1,26,000 of tax on it is
nobody's asset yet.

**Money in** — received · TDS deducted by the client · outstanding AR (incl GST) · advance
held in 2400 and the GST already paid on it under rule 50 (`docs/54`).

🔴 Received per project comes from `ReceiptAllocation` → invoice → project, **not** from the
journal: one receipt can settle invoices across several projects, which is exactly why
`postReceipt` is called without a project today and should stay that way.

**Cost — direct only** — staff (via `StaffAllocation`) · vendor · other, then the two lines
from §4: cost carrying blocked GST, and cost with no GST at all.

**Tax** — output GST charged, by head · input GST booked · of which confirmed in GSTR-2B ·
RCM on this project's costs (blocked, see §9). Marked *indicative* throughout, per §2.

**Margin — direct**
- **Against contract** is the headline: `(contract − direct cost) ÷ contract`. Divine Ragas
  tracks at 87.5%.
- **To date** is a second, labelled line: `(revenue − direct cost) ÷ revenue`. Honest once a
  project closes, misleading before.
- 🔴 **Neither is printed as a bare coloured percentage on a part-billed project.** Today's
  screen shows Divine Ragas at a red **0.0%** because one cost happens to equal the first of
  eight bills. That is not a project in trouble; it is a number with no meaning yet.

## 6. The three ledgers

**Client ledger** — a true running balance, over **two control accounts, not one**: 1100 AR
*and* 2400 advances. A client who has paid an advance owes less than their AR says. TDS
credited (1310/1320) appears as its own row, so a ₹1,18,000 invoice settling with ₹1,08,000
of cash reads as settled rather than ₹10,000 short.

Rows: invoice · credit note · debit note · receipt · TDS credited · advance received ·
advance absorbed · refund voucher.

**Vendor ledger** — the same shape over 2000 AP, with **the TDS withheld** (2210/2220/2230)
as its own row. A ₹1,00,000 bill with ₹10,000 deducted leaves ₹90,000 payable to them and
₹10,000 owed to the government; without that row the closing balance does not match the
payment. `postTdsDeduction` already carries the vendor.

**Project statement** — §5.

🔴 **Reuse `accountLedger`'s ordering exactly** — `[date, entryNo, id]`. `JournalLine` has no
ordering column, so the two sides of one entry come back however Postgres feels, and a
running balance computed line by line differs between two exports of the same ledger
(`docs/58`). A new query with its own `orderBy` produces a vendor statement that disagrees
with itself.

🔴 **The reconciliation is the guard.** Sum of all client ledgers must equal 1100; all vendor
ledgers, 2000. That is `docs/80`'s defect class on the party side: a future posting that
forgets `customerId` drops money out of every party ledger while the trial balance still
balances. It is zero today, and a test keeps it zero.

Each exports to CSV for the CA under `docs/36`'s rules; client and vendor also to PDF,
because those are sent to the party.

## 7. Making "all tracked per project" true

Three different problems, and only one of them is a field:

1. **Payroll is the big one.** Salary reaches a project only through `StaffAllocation`, and
   ₹11,73,000 of director's remuneration and staff salaries has none. Needs an allocation
   coverage view — per employee, per month, allocated against 100% — and a warning when
   payroll runs for an unallocated employee. The largest cost in this company is otherwise
   invisible to every margin on the screen.
2. 🔴 **Bills and expenses must not be forced.** Cloud hosting and domains are genuine
   overhead; a mandatory project field would invent project costs that do not exist. What is
   needed is an **untagged-cost queue**: list them, assign or deliberately mark as overhead,
   so untagged comes to mean *decided* rather than *forgotten*.
3. **Two paths cannot carry a project at all** — the RCM self-invoice (§9) and bank charges.

And because the margin is direct, the projects screen must show **overhead — not attributed
to any project** as a figure beside the table. The page already says *"a cost only reaches a
project if it is tagged to one"*; it needs a number next to the sentence.

## 8. What this must never do

- A per-project **GST payable** — §2.
- Apportioned overhead in a margin called direct.
- A margin percentage presented as a verdict on a part-billed project.
- "Contract GST" as a receivable — §5.
- A project statement with a running balance that reads like something owed.

## 9. Dependencies

| | |
|---|---|
| Output tax per project | ✅ fixed — the four adjustment paths now carry the project, guarded by test |
| RCM line | ⛔ blocked on the RCM dimension gap: `postRcmSelfInvoice` carries no dimension at all, so a foreign-supplier cost tagged to a project books 2140/1240 outside it |
| "Confirmed in 2B" column | needs `docs/62`'s reconciliation as its source |
| `docs/80` | still unwritten — the bug hunt it refers to is committed-pending and undocumented |

## 10. Build order

1. **Project statement** — read model and page. Most of the value, no new concepts, and every
   figure already exists in the journal.
2. **Untagged-cost queue and the overhead figure.** Before anyone trusts a margin, not after.
3. **Client and vendor ledgers**, with the reconciliation guard.
4. **Allocation coverage**, which is what moves the ₹11.73L.
5. **RCM dimension**, then the RCM line.
6. **2B-confirmed column.**

Each step ships with its own guard, on the principle that has paid every time in this
project: close the gap, then make a test that fails without the fix.
