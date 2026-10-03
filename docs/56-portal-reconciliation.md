# 56 · The portal — checking what was only ever taken on trust

**Status: done.** 717 tests (330 unit + 387 integration), typecheck and lint clean,
production build passes.

Both electronic ledgers in this system are derived from our own journal. Every challan
reference was typed in by a person, and the TDS CIN is not even typed in — it is
constructed. Fifty-five modules in, **nothing here had ever been compared with what the
department actually holds.**

---

## 1. 🔴 There is no API call here, and there will not be

docs/00 §6 rules out live filing, and that rules out live lookups with it. The portal's word
arrives the way the CA's word arrives: as a statement somebody downloaded and brought here.

So the module takes that seriously rather than apologising for it. A statement is **kept**,
with the date its figures are as at and the file it came from, because *"the portal agreed on
30 September"* is the only answer to a notice that arrives in March — and a live lookup could
never prove it.

The date asked for is the date on the **download**, never today. A statement pulled on Monday
showing Friday's position, filed under Monday, compares our Monday balance against the
portal's Friday one and reports a difference that is not there.

## 2. 🔴 The two credit ledgers are not the same quantity

This is the whole module, and getting it wrong is worse than not comparing at all.

| | |
|---|---|
| **Our** credit ledger | input credit the books have accrued, the day each bill posts |
| **The portal's** | input credit a **filed GSTR-3B** has claimed |

Subtract one from the other and a company that files quarterly reports a terrifying hole
every month of the year, which means nothing whatsoever. After three or four of those nobody
looks at the screen again, and the one difference that mattered goes past unread.

So the comparison has three columns, not two: what our books say, **what the portal should
therefore be holding**, and what it says it holds. The middle column subtracts credit sitting
in periods where no GSTR-3B is recorded as filed — which is exactly why docs/44 had to exist
before this could.

What is left over is not a timing difference, and the screen says so:

> Credit has been claimed that the portal does not hold. Under **s.16(2)(aa)** credit is not
> available at all unless the supplier declared the invoice and it appears in GSTR-2B — if it
> was claimed in a filed return it has to be reversed with interest at 18% under s.50(3) read
> with rule 88B(3).

The cash ledger is the opposite case, and it is told to agree to the rupee: a challan credits
it the day the bank confirms and a set-off debits it, with no timing to allow for. A shortfall
on our side is read as a challan generated and never paid — a CPIN with no CIN — and if a
set-off is recorded for a period with no GSTR-3B filed against it, the screen names that
period instead, because then the liability is still live and interest is still running.

## 3. 🔴 The CIN this system built was the wrong way round

An OLTAS challan identification number is the BSR code, then the date of tender as
**DDMMYYYY**, then the 5-digit serial. `createChallan` built it as **YYYYMMDD**.

Twenty characters either way, so nothing ever complained — and the 26Q carries the CIN.
TRACES matches on it and rejects **the challan, not the file**, so every deductee on it would
have lost their credit while the return itself sailed through.

Fixed, with the shape now in one named function. Challans created before today keep the old
string, so three things look for it: the return's own pre-filing checks warn when a stored CIN
is not the one its references make, the portal screen counts them, and a reconciliation that
finds the challan simply **takes the portal's CIN over ours** — ours was constructed, theirs
was issued.

## 4. What has not been checked, as against what is missing

The first version listed every GST challan under *"the portal's challan history has nothing
matching this — a CPIN with no CIN is a challan generated and never paid"*, when no GST
statement had been imported at all. The same bug had a quieter form: a challan deposited
**after** the statement's date cannot be on it either.

Both are the same mistake — reading silence as denial — and both accuse a challan that was
paid last week of never having been paid. There is now a third class, `unchecked`, which says
which it is: nothing imported, or imported but older than this payment.

The headline figure on the screen is the one nobody would otherwise see: **challans never
checked**, because a challan records itself as paid and then looks exactly like one somebody
verified.

## 5. Reading a statement nobody formatted for us

Two parsers, both reporting what they cannot read rather than dropping it.

- 🔴 The portal calls the heads *Integrated Tax*, *Central Tax* and *State/UT Tax*. All three
  contain the word "Tax", so a loose match assigns the whole statement to one head and the
  reconciliation then passes while the books are out. A line naming more than one head is a
  **header**, and is either read positionally or reported — never given to the first match.
- 🔴 In a challan line every cell is classified **once**. The obvious version — find the
  references, then take the biggest number as the amount — reads the challan serial `02001`
  as ₹2,001, and on a line with no amount column at all it invents one.
- 🔴 The CIN is matched before the BSR code, because an OLTAS CIN *begins* with the BSR code:
  looking for the BSR first finds it inside the CIN and then looks for a serial inside the date.

## 6. What rendering found

Four things, and three of them were the same mistake in different clothes.

- With nothing imported, every head was tagged **look at this** with a sentence scolding the
  statement for not mentioning it. Four invented problems on a screen whose whole job is to
  say which problems are real.
- Taking the portal's CIN was reported as a **mismatch** — so the banner said "2 to look at"
  while the figures directly above it said "1 of 1 confirmed". A correction is not an
  outstanding problem, and the two are now separate.
- The GST challan accusation in §4.
- On a phone the verdict pill squeezed the card title to one word a column wide, and five
  columns of money collapsed into each other. The verdict moved into the subtitle and the
  heads stack below `sm`.

## 7. Still open

- **Nothing compares invoice by invoice.** This reconciles balances and challans. GSTR-2B
  against our own purchase register is the next layer down, and it is the one that finds
  *which* supplier did not file.
- 🔴 **Reverse-charge credit sits in one account** (`1240`) and is split across heads on the
  portal. While any is held, the head-wise credit lines are approximate and the screen says
  so; the totals stay exact. Splitting 1240 three ways is the fix, and it touches the RCM
  posting rules.
- **Nothing reconciles the liability register** — what the portal thinks is payable, against
  what the books do.
- **Nothing files away the statement itself.** The rows are kept; the PDF or Excel the person
  downloaded is not attached (docs/38 storage would take it).
- **A difference is reported, never resolved.** There is no "write this off" or "post the
  correction" — deliberately, for now: each cause needs its own posting, and guessing is how
  a reconciliation becomes a fiction.
- Carried forward: payslip documents, statement PDFs, journal export, attachments on the
  expense screens, service-item CRUD, the mobile tail, chases that nobody sends, note
  amendments (table 9C), refund vouchers.
