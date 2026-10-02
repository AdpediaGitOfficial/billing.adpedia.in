# 51 · The last two documents that could not be undone

**Status: done.** 630 tests (314 unit + 316 integration), typecheck and lint clean,
production build passes.

Eleven document types post journal entries. After docs/40, docs/49 and docs/50, two were
still permanent: a credit note and a GST set-off. Both now reverse, each refusing on the one
thing that has left the building — and the §2 treatment from docs/50 decides what that is.

---

## 1. Reversing a credit note

🔴 **Refused once the GSTR-1 that declared it has been filed.** A credit note in table 9B is
not only our record: it has reached the customer's **GSTR-2B** and reduced the input credit
they may claim. Withdrawing it here leaves them holding a reversal this company no longer says
it issued, and they find out at reconciliation. The refusal points at a debit note or an
amendment in a later return, which is how that correction is actually made.

A **commercial** credit note (docs/48) is never in GSTR-1 at all, so no filing blocks it —
nothing reported it.

Otherwise it reverses the journal and 🔴 **puts the invoice's status back**. Crediting an
invoice in full marks it `PAID` (docs/42); leaving that in place would show an invoice settled
by a credit note that no longer exists, and drop it out of the ageing that should be chasing
it. The status is recomputed from what is actually left: receipts, TDS credited, and the
credit notes that survive.

The cancelled note keeps its number and its row — the series may not have unexplained gaps —
and it stops using up the invoice, so the same value can be credited again on a corrected note.

## 2. Reversing a GST set-off

🔴 **Refused once the GSTR-3B it discharged has been filed**, because the set-off *is* table
6.1 of that return. The credit utilised and the cash debited are what was declared, and the
portal has already debited the real electronic ledgers to match. Reversing it here would leave
this system's ledgers disagreeing with the portal's — and the electronic ledgers (docs/46) are
the one place in this system whose figures are meant to be a mirror of somebody else's.

Otherwise everything goes back: the liability returns, the credit ledger is restored, and the
cash ledger holds the money again. 🔴 That last part is the true position rather than a
convenience — money that was never debited **is** still sitting in the cash ledger, and the
screen says so: after a reversal the period shows as undischarged with the cash still there,
ready to be set off again.

## 3. What rendering found

🔴 **The GST page would not load at all** once a future financial year existed.

Docs/49 swept twenty-five "newest open financial year" lookups with a regex, and it missed
two — both written with the `companyId,` shorthand the pattern did not match. One of them sat
in `previewSetOff`, so with FY 2027-28 on file the page threw
*"2026-Q2 is not a filing period for FY 2027-28"* and rendered a server error. The sweep had
looked complete: typecheck passed, 603 tests passed, and the page it broke was the one nobody
re-opened afterwards.

Both are fixed, and a test now greps the source for the pattern, because a grep is a cheaper
guard than another render.

## 4. Where reversal now stands

| Document | Reverses | Refuses when |
|---|---|---|
| Invoice | docs/21 | a receipt exists — raise a credit note |
| Receipt | docs/40 | the TDS is matched to 26AS |
| Bill payment · Expense · Bank match | docs/40 · wired in docs/49 | the period is locked |
| Payroll run | docs/50 | the TDS is deposited, or the 24Q reported it |
| TDS challan | docs/50 | the return reported the deposit |
| **Credit note** | **docs/51** | **the GSTR-1 declared it** |
| **GST set-off** | **docs/51** | **the GSTR-3B declared it** |

The shape is the same every time, and it is worth stating plainly: **a document may be
reversed until somebody outside this company has been told about it.** Filing is the moment
that changes, which is why docs/44 and docs/50 had to exist before docs/51 could.

## 5. Still open

- ~~**Revised returns are still not modelled**~~ — done in **`docs/52`**, for both taxes.
- **A reversal cannot itself be reversed.** Re-record the document; the pair stays in the
  journal either way.
- **Debit notes** (s.34(3)) remain the honest answer to "the credit note was too large", and
  they are not built.
- Carried forward: advance receipts, PDF statements, journal export, service-item CRUD,
  Form 16/16A issuance.
