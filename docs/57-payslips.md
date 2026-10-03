# 57 · Payslips — and the first document where the reader matters

**Status: done.** 754 tests (352 unit + 402 integration), typecheck and lint clean,
production build passes.

`htmlToPdf` has been waiting since docs/33 and there was no payslip template. A payslip is
the one document an employee actually asks for — for a landlord, a bank, a visa desk — and
this system has been running payroll for twenty-four modules without producing one.

Building it turned out to be two jobs. The document was the smaller.

---

## 1. 🔴 Five API routes had no authorisation at all

A payslip cannot ship next to this, so it did not.

`requireContext()` proves the caller is signed in **to this company**. That is the whole
check on most of the API, and for an invoice it is the right one: the finance team all work
on the same invoices. Five routes went straight from there to the data —

| | |
|---|---|
| `/api/invoices/[id]/document` | every invoice ever issued |
| `/api/credit-notes/[id]/document` | every credit and debit note |
| `/api/invoices/preview` · `/api/bills/preview` | pricing and tax on anything |
| `/api/dashboard` | the whole company position |

— and an **EMPLOYEE**, who holds `expenses.own` and `payroll.own` and nothing else, could
read all of it by walking ids.

🔴 It was invisible because `renderInvoiceHtml(companyId, id)` takes a **companyId rather
than a context**. There is no unused argument, no missing parameter, nothing a type checker
or a reviewer would catch — the call simply never had the chance to ask who was asking.

A grep is the only thing that finds that, so the grep is now a test
(`tests/route-authorisation.test.ts`): every route must call an authorisation helper, or be
listed as exempt with the reason. Six auth endpoints and three routes whose services assert
internally are on the list; **nothing that renders a document may be**, and the test says so
separately.

## 2. 🔴 "Own" has to mean own

An EMPLOYEE's capability is `payroll.own`. The only honest reading of *own* is their own
slip — so the payslip route is the first in this system where **who is asking decides the
answer**, not merely whether they may ask.

`assertMayReadPayslip` runs before anything is rendered:

- `payroll` → any payslip in the company (the accountant, the auditor, the owner)
- `payroll.own` → only where the slip's employee is this user
- anything else → refused

🔴 And no employee record means **no**, never "therefore allow". The permissive reading of an
unmatched email is the one that hands over the payroll.

There is no `userId` on `Employee`; the match is by email within the company. `/payroll/me`
had grown its own copy of that rule, and a second copy in the route is exactly how two rules
drift until one is wrong — so `employeeForUser()` is one function and both use it.

## 3. 🔴 The explanation is snapshotted, not recomputed

Salary TDS under s.192 is an estimate of the year's liability spread over the months that
remain. The reason October's deduction was ₹4,000 **stops being true in November**.

The run had always computed that reason and shown it on the preview screen, then thrown it
away. A payslip reprinted in March would have explained an October deduction with arithmetic
that did not exist in October. So `tdsNote` and `professionTaxNote` are frozen on the payslip
when the run is approved — the same rule as the filing snapshot in docs/44, for the same
reason: a statement to somebody outside this company has to keep saying what it said.

## 4. What the document itself has to carry

There is no single statutory payslip format for a private company in India. What the law asks
is that the employee can see what was earned and what was taken off, item by item — s.50 of
the Code on Wages 2019, and the wage-slip rules under the state shops-and-establishments Acts
until it is in force everywhere. So every deduction is named with what it is made under, and
the two that are routinely mistaken for errors carry their own sentence:

- **s.192 is not a tax on this month.** It is the year's estimate spread forward, so the
  figure moves when the estimate does — and it is printed with the month's own reasoning.
- **Profession tax appears in two payslips out of twelve**, in September and March, because
  Kerala levies it half-yearly. Ten nil months are correct, not an omission, and the year
  cannot exceed ₹2,500 — Article 276(2).

Also on it, and each for a reason: **year to date**, because that is what Form 16 will be
built from and the employee is the only person who can notice it is wrong; the **bank account
as its last four digits only**, because a payslip is forwarded further than any other document
this system makes; and a **void banner** on a cancelled run's slip, which docs/50 keeps on
file and which otherwise prints as though somebody had been paid.

A draft run's payslip is refused outright. Its figures still move, and the employee keeps the
paper.

## 5. What rendering found

- 🔴 The document **promised the employee their tax would appear in Form 26AS** — on a slip
  for somebody with no PAN, where it cannot. s.206AA makes the PAN the thing a deduction is
  reported *against*; without one the money reaches the department and is credited to nobody.
  The slip now says so above the fold, and the declaration that contradicted it is replaced
  rather than left standing.
- The profession-tax note printed **`slab ₹12500 on ₹1428000`**. Ungrouped money reads as a
  figure nobody checked. It is formatted at source now, because that note goes on paper.
- A sentence read `…for the period shown; The tax deducted…` after the replacement above.

## 6. Still open

- **Nothing emails the payslip.** It is produced on request and downloaded; delivery is still
  a person attaching a file.
- **`Payslip.pdfUrl` is still unused.** Documents are rendered per request rather than stored
  (docs/38 §7 notes the same for invoices) — which also means a reprinted slip reflects the
  employee record as it is *now*, where the snapshot in §3 covers only the tax reasoning.
- **No days-paid or loss-of-pay line**, because there is no attendance in this system and
  inventing one would be worse than omitting it.
- **No UAN or ESIC number**, which EPF and ESI would require — neither applies at this
  headcount (docs/04 §6).
- 🔴 **`Employee` has no `userId`.** The email match works and is scoped to the company, but
  an employee who changes their sign-in address silently loses their own payslips.
- Carried forward: statement PDFs, journal export, attachments on the expense screens,
  service-item CRUD, the mobile tail, chases that nobody sends, note amendments (table 9C),
  refund vouchers, invoice-level GST reconciliation.
