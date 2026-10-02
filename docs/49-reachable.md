# 49 · The services nothing could call

**Status: done.** 603 tests (314 unit + 289 integration), typecheck and lint clean,
production build passes.

Docs/39 was found by asking which services had no UI caller. Asking it again, with a script
this time, found that the question had never been fully answered — and one of the answers was
a security hole.

---

## 1. What the survey found

Every exported service function, checked against every page, route and action:

| | |
|---|---|
| `cancelBillPayment` | a payment entered twice, or against the wrong bill, could be corrected only in the database |
| `cancelExpense` | 🔴 and it had already claimed input credit, so the claim stood in the GST position with nothing able to undo it |
| `unmatchBankTransaction` | a wrong match was permanent in the one screen whose whole job is deciding what a line is |
| `deletePasskey` | 🔴 **a passkey on a lost phone kept working** |
| `updateVendor` | built in docs/41, with its audit trail, and no page |

🔴 Docs/40 built four corrections and shipped **one** button. The receipts screen got it; bill
payments, expenses and bank matches did not, and nothing said so — the services were tested,
so every signal the project reads said that work was finished.

## 2. 🔴 A passkey could be added and never removed

`listPasskeys` and `deletePasskey` have existed since phase 9. The settings screen showed a
**count**. So a phone that was lost, sold, or left behind at a previous job kept a working
credential to the company's books, and the only way to revoke it was the database.

The screen now lists each passkey with when it was added, when it was last used, and whether
it is synced to a cloud keychain — and removes it on sight of its label. The removal is
**audited**, because the row itself is gone afterwards and the audit log is the only remaining
record that the credential ever existed.

## 3. One button, not four

The four corrections are the same act on different documents, so there is one
`ReverseButton`: it asks why, refuses a reason under five characters, and posts. Three
near-identical copies would have been three places for that to drift.

🔴 It refreshes the page after a reversal. Without that the row sat there exactly as it was —
a cancelled payment still offering to be cancelled, a bank line still listed as matched — and
the next click was against something that no longer existed.

### And the matched lines had to be shown at all

The reconcile screen counted them and listed only what was left: *"47 of 60 done"*. A line
matched to the wrong invoice was invisible from the moment it was matched — the number went
up and the mistake went quiet. You cannot unmatch what you cannot find, which is why the
service had nowhere to be called from. The screen now lists what it matched, what each line
was matched **to**, and why.

### A cancelled expense stays on the list

It used to be filtered out — reasonably, to stop it double-counting against its reversal. But
nothing financial is deleted in this system, and an expense that vanishes when cancelled is
indistinguishable from one that was deleted. The receipts list had already settled this the
other way: show it, strike it through, keep it out of the count.

## 4. 🔴 The financial year everything thought it was in

Found by rendering: the header read **FY 2027-28** in October 2026.

Twenty-five call sites asked for *"the newest OPEN financial year"*. Next year's row has to
exist before April — the document series are created against it, and numbering refuses
without them — so the moment anyone creates it, the dashboard, the GST position, the PAN
register, the compliance calendar and the invoice list all jump to an empty future year.
Nothing errors. The figures simply go to zero, with the real year still running.

`currentFinancialYear()` answers with the year **covering today**, and keeps the old
behaviour only as the fallback for when no year covers today at all: before the first one
exists, after the last one ends, or while standing inside a year that has been closed.

## 5. Editing master data

One form serves creating and editing, for vendors and for projects. The vendor form derives
reverse charge and the TDS consequences live as you type; copying it would have meant two
places for those warnings to drift apart, on a screen whose entire value is that it tells you
what a field is about to do.

Both edit screens say what the edit will *not* do:

- **Vendor** — changing the PAN, the section or the country governs **future** bills. What was
  already deducted has been reported, and a bill that quietly re-rated itself would no longer
  agree with the return that carried it (docs/41's rule, applied to the other side).
- 🔴 **Project** — the name is printed on the invoice document, so renaming it changes what
  this system reproduces for invoices the client already holds. Changing the client moves the
  whole history into a different client P&L.

And a vendor edit no longer undoes a confirmed PAN card unless the number itself changes —
the card is evidence for the number it was checked against (docs/47).

## 6. Still open

- ~~**Payroll runs and TDS challans still cannot be cancelled.**~~ Done in **`docs/50`**,
  which found that the system could not have decided it: there was no record of a TDS return
  ever being filed, so nothing could tell a mistake from a reported fact.
- **A credit note and a set-off cannot be reversed** (docs/46, docs/48).
- **`registerEInvoice` and `cancelEInvoice` have no caller either** — deliberately, since the
  IRP adapter is gated off (docs/31 §6).
- **No undo for the undo.** A reversal cannot itself be reversed; re-record the document.
- Carried forward: debit notes, advance receipts, PDF statements, journal export,
  service-item CRUD.
