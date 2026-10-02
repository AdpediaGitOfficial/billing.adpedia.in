# 53 · Debit notes

**Status: done.** 661 tests (314 unit + 347 integration), typecheck and lint clean,
production build passes.

The mirror of docs/48: where the value or the tax charged on an invoice turns out to be
**less** than it should have been, s.34(3) says the supplier issues a debit note and the
client owes more. Same document under rule 53(1A), same `cdnr` table, opposite sign.

🔴 And three rules that are *not* the mirror — each of which would have been got wrong by
reading across from the credit note, which is exactly what building it this way invited.

---

## 1. 🔴 There is no deadline

s.34(2) time-bars a **credit** note to 30 November following the financial year of supply.
That restriction exists because a credit note reduces the government's tax. A debit note
increases it, so nothing restricts when it may be issued — a debit note raised two years later
is perfectly valid.

The credit-note code has an entire branch for the deadline (`gstAdjusted`, `taxNotAdjusted`,
the commercial-note path from docs/48). The debit note has none of it, and `gstAdjusted` is
hard-coded true with a comment saying why, so nobody later adds the branch back by symmetry.

## 2. 🔴 The tax belongs to the month the note is issued

s.34(4). Not to the invoice's month — so **no interest runs for the period in between**, which
is the first thing anyone assumes there must be. The note says this on its face, because the
client's accounts team assumes it too.

## 3. 🔴 The recipient's credit runs from the note's own date

s.16(4) was amended with effect from 01 January 2021 to key the input-credit deadline to the
debit note rather than to the original invoice. So a debit note raised long after the invoice
still gives the client credit — and guidance written before 2021 says the opposite, which is
why the document spells it out rather than leaving them to look it up.

## 4. One table, one template

```
model CreditNote { noteType: CREDIT | DEBIT, … }
```

Both live in the same table, because the law treats them as one document facing two ways:
rule 53(1A) fixes identical contents, GSTR-1 reports both in `cdnr` with a flag, and the
posting is a mirror. The table keeps its original name rather than taking a migration for a
word.

That reuse is what the module is mostly made of — the document renderer, the cancellation from
docs/51, the invoice listing and the GSTR-1 path all already worked. What the debit note adds
is its own series (`ADPD/26-27/0001`), its own posting direction, and the three rules above.

**The posting is the invoice again, for the extra**: receivable up, revenue up, output tax up.
🔴 And an invoice that had been *paid* stops being settled, because more is owed than has been
received.

## 5. What rendering found

The tests were green and the document still said the wrong thing in three places:

- the meta strip was labelled **"Credit Note No."** above a debit note's number
- the line read **"Credit against tax invoice …"**
- the browser tab — which becomes the filename when a client prints the page to PDF — still
  said **Credit Note**

All three were places where the template's own words had to be swapped rather than inherited,
and all three are now asserted in the test.

## 6. Still open

- **Credit-note and debit-note amendments (table 9C)** — the docs/52 treatment, against a note
  rather than an invoice.
- **A debit note cannot be raised without an invoice.** s.34(3) contemplates one against a
  specific tax invoice, which is how it is built; a standalone charge is a fresh invoice.
- **No register of notes as a series** — they are listed on the invoice they attach to
  (carried from docs/48).
- Carried forward: advance receipts, PDF statements, journal export, service-item CRUD,
  Form 16/16A issuance.
