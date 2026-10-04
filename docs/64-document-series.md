# 64 · The series, and the holes in it

**Status: done.** 864 tests (381 unit + 483 integration), typecheck and lint clean,
production build passes.

Rule 46(b) requires an invoice number to be **consecutive**, unique for the financial year,
and at most sixteen characters. Rule 53(1A)(c) says the same of a credit or debit note, and
rule 49 of a receipt voucher.

This system has had an unbroken allocator since docs/10 — the sequence taken by the database
inside the document's own transaction, under `SELECT … FOR UPDATE`. What it has never had is
any way to *show* that, which is the only form in which it is any use to somebody being asked.

---

## 1. 🔴 A validator with tests and no caller

`validateInvoiceNumber` has existed since docs/10. It knows rule 46(b) — sixteen characters,
letters, digits, `/` and `-` — it has five tests, and **nothing in the application has ever
called it**. A series configured with a longer prefix would have produced a defective number
on every invoice for the year, and nothing anywhere would have said so. The validator sat in
the same file as the allocator the whole time.

🔴 It is now called at the moment the number comes into existence, and it **fails the
allocation** rather than warning afterwards — the alternative is a document issued to a client
with a bad number on it, which cannot be taken back. A test confirms the refusal happens
*before* the sequence is consumed, because a failed allocation that took a number would create
exactly the hole this module reports.

docs/49 swept this codebase for services nothing could reach and found four. It missed this
one because it was looking for services; a pure function is just as unreachable and leaves no
dead screen behind to notice.

## 2. 🔴 Not every missing number is missing

Adpedia's invoice series was seeded at **26**, because twenty-five invoices were raised by
hand before this system held the series (docs/03). Reporting those as twenty-five missing
invoices would bury any real gap under a permanent false alarm — and a permanent false alarm
is one people learn to scroll past, which is how the real one goes unseen.

So a gap below where the series opened is reported as **explained**, in those words, and only
a number taken *from* the series with no document behind it is called unexplained.

🔴 And a cancelled document is not a gap at all. The first version had a `CANCELLED` gap
reason; the code to produce it turned out to be unreachable, because a cancelled invoice keeps
its number — which docs/41 decided deliberately, since a cancellation that released its number
would create the very hole this page exists to find. Cancellations are listed in their own
right, because an assessment asks about them; they are simply not holes.

🔴 A **draft** has taken nothing either. It carries a placeholder number and `seq: 0`, so
counting it would put a document at sequence zero and make every real number above it look
like a gap.

## 3. The sequence, read back out of the number

Only `Invoice` stores the `seq` it was allocated. A credit note, a self-invoice and a receipt
voucher keep the rendered string alone — so rather than add a column to four tables and leave
every existing row null, the number is parsed against **its own pattern**. The pattern is what
produced it, so it is the one thing guaranteed to fit, and a number from a different series
returns nothing rather than a wrong answer.

## 4. What the register says about the real books

> **Tax invoices** `ADP/{FY}/{SEQ:4}` · next `ADP/26-27/0029` — 3 issued, 26 to 28
> `1–25` — *The series opened at 26. Numbers below that were issued before this system held
> the series, and are not missing from it.*
>
> **Unexplained gaps: 0.** Every number is accounted for.

That is the whole point of it: not a reassuring absence of warnings, but a statement that can
be shown to somebody.

## 5. What writing it found in itself

🔴 The guard from docs/49 — the one that greps the source for *"the newest open financial
year"* — failed on this module's own first draft, which had written exactly that lookup
instead of calling `currentFinancialYear()`. Next year's row exists before April because the
numbering needs it, so the raw lookup would have jumped a year ahead and reported every series
as empty. A test that fails on new code three modules after it was written is the kind worth
having.

## 6. Still open

- **No way to change a pattern from the screen.** The register now refuses to issue under a
  bad one, and fixing it is still a database edit — which is the same gap as service-item CRUD
  and company details, and wants one settings module rather than three.
- **Proformas and quotations have series and no documents.** They are allocated by nothing, so
  they sit at 1 for ever; harmless, and worth removing if those documents are never built.
- **The register is per financial year** and defaults to the current one. Last year's series is
  reachable by id but nothing links to it.
- Carried forward: service-item CRUD, note amendments (table 9C), refund vouchers, swipe
  gestures and the performance budget.
