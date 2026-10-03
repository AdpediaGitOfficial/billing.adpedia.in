# 62 · Which supplier did not file

**Status: done.** 847 tests (376 unit + 471 integration), typecheck and lint clean,
production build passes.

docs/56 could compare the two credit ledgers and say that so many rupees of claimed credit
were not on the portal. It could not say **whose** — and that is the only form of the answer
anybody can act on, because the remedy is to telephone a supplier.

---

## 1. 🔴 s.16(2)(aa) is the whole reason this matters

Input credit is not available **at all** unless the supplier has furnished the invoice in
their GSTR-1 and it appears in the recipient's GSTR-2B. A bill sitting in our books and
missing from 2B is not a timing difference and not a bookkeeping error: it is credit that may
not be taken, and where a GSTR-3B has already claimed it, it must be reversed with interest at
18% under s.50(3) read with rule 88B(3).

Every message this module produces says that, with the supplier's name and the figure.

## 2. 🔴 The portal's own JSON, because that is what it hands you

GSTR-2B downloads as JSON, and it is read directly. Re-keying it into a spreadsheet first is
where transcription errors enter a reconciliation whose entire purpose is to find
discrepancies — and the document carries a field no hand-made sheet will have:

> **`itcavl`** — the portal's own verdict on each invoice. `"N"` means it is telling you not
> to claim this one: the place of supply is outside the state, or the supplier filed after
> the s.16(4) deadline.

That is honoured, not ignored. An invoice we matched happily and the portal marks unavailable
is reported separately from one that is simply absent, because the remedy is different: there
is nobody to chase, and the claim has to come out.

A sheet is accepted too — but 🔴 only with a header row naming the tax columns. Guessing which
of four money columns is CGST is how a reconciliation compares the wrong figures and declares
everything matched.

## 3. 🔴 The invoice number the two sides never spell the same way

A supplier files `EX/300`. The person entering the bill types `EX-300`, or `ex 300`, or
`EX 300 ` with a trailing space off a PDF. Matching on the literal string finds almost nothing
and reports a company's entire purchase register as unavailable credit — which is both
terrifying and useless, and would be abandoned on first use.

Case and punctuation go; the digits and letters stay. A dev-data bill entered as `EX-300`
matched the portal's `EX/300` on the first run, which is the whole point.

🔴 And the match is by **GSTIN and number first**, with amount only as a fallback. Two
invoices from one supplier in one month for the same amount are ordinary — a monthly retainer
is exactly that — so matching on amount pairs them arbitrarily and then reports both as fine
while they are crossed over.

## 4. What is reported, in the order that matters

| | |
|---|---|
| **In our books, not in 2B** | the money: s.16(2)(aa), named supplier, with the reversal consequence |
| **Matched, but the portal says unavailable** | the claim has to come out; there is nobody to chase |
| **Tax differs** | only the lower figure is available |
| **In 2B, not in our books** | credit nobody claimed — *and an expense missing from the P&L with it* |

🔴 Only the **excess** counts as at risk where the two differ. Claiming ₹9,000 against a 2B
showing ₹8,500 risks ₹500, not ₹9,000; the other way round nothing is at risk at all. Summing
whole invoices would produce a frightening number that no action follows from.

Bills where credit is blocked under s.17(5) are left out entirely. They are not 2B's business,
and reporting them as missing would bury the ones that are.

## 5. 🔴 It becomes a chase

Reading the finished screen made the connection obvious: the last sentence of every
"not in 2B" row was *"ask them to include it in their next GSTR-1"* — which is a message, and
docs/61 exists to write messages. It is now a chase kind of its own, with the supplier's
address, the invoice number and the figure in it. It is the chase with the clearest price on
it, and the remedy really is a telephone call.

That required splitting the comparison in two. `compare2b` reads and returns; `reconcile2b`
compares and then writes the match back. A page that writes to the database in order to render
itself turns a refresh into a side effect — and a second copy of the matching rules inside the
chase service would be the docs/49 mistake, where two implementations of one rule drift until
one is wrong.

## 6. What the tests found

- The first version re-derived the pairings afterwards in order to write them back, using
  only the **first** tier's rule. Everything matched by the looser two was matched in the
  report and left unmatched in the database. The pairing is remembered as it is made now.
- A test expected a bill from an unregistered supplier to appear as missing credit. It does
  not, and should not: `createBill` correctly charges no GST and marks it ineligible, so it is
  outside a credit reconciliation. 🔴 The case that *is* dangerous — a taxed bill whose
  vendor's GSTIN was cleared afterwards, leaving a live claim with nothing to match — is now
  what the test builds.

## 7. Still open

- **Reversal is reported, never posted.** The screen says ₹9,000 must come out with interest;
  making that entry is a decision with a date on it, and guessing the date is how a
  reconciliation becomes a fiction.
- **No period filter.** A 2B is monthly and this compares it against every open bill, so an
  invoice from a later month reads as missing until the next statement arrives. The statement's
  `asOn` is kept; using it to bound the comparison is the next thing.
- **Credit notes and debit notes** in the 2B (`cn`, `dn`) are parsed as part of b2b only where
  the portal nests them there; the separate sections are not read yet.
- **🔴 Account 1240 is still one account.** Reverse-charge credit is a single balance here and
  three heads on the portal, so docs/56's head-wise credit comparison stays approximate while
  any is held. Splitting it is a chart-of-accounts change and a reclassification entry.
- Carried forward: service-item CRUD, note amendments (table 9C), refund vouchers, swipe
  gestures and the performance budget.
