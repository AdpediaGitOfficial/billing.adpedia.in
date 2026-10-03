# 59 · The document that was issued, and the bill behind the claim

**Status: done.** 786 tests (353 unit + 433 integration), typecheck and lint clean,
production build passes.

Two gaps that turn out to be the same gap: **evidence was never kept where the thing it
evidences lives.** The expense screens had no attachment panel at all, and no document this
system produces was kept — every invoice, note and payslip was re-rendered on request.

---

## 1. 🔴 A re-rendered invoice is not the invoice that was sent

Every document here is rebuilt from today's data and today's template. docs/41 froze the
bill-to details so a customer's new address could not rewrite an old invoice — and that was
only half of it. The **company's own** address, the logo, the signature and the template
itself are all read live. docs/33 fixed three defects in the invoice layout; docs/48 changed
its bindings; docs/57 and docs/58 added two more templates beside it.

For a tax invoice that is not cosmetic. The question at an assessment is **what did you
issue**, and nothing here could answer it — only what the same data would look like today.

So the bytes are archived at the moment of issue, as an attachment against the document,
and the route serves **those bytes** ever after. `?rebuild=1` re-renders deliberately, and
every response says which it is in `x-document-source`.

### The proof, from one invoice

An invoice was sent and the archived copy kept; the same invoice was rebuilt seconds later
on the same machine. **433,850 bytes against 78,679**, and on the page the supplier block
breaks over three lines in one and two in the other. Nothing had changed but the renderer's
state. Over months, with the template moving underneath it, the difference is not a line
break.

## 2. 🔴 The moment of issue is different for each document

| | |
|---|---|
| **Invoice** | when it is **sent**. `sendInvoice` is the issuing act and rule 46 fixes the contents at issue |
| **Credit / debit note** | when it is **raised**. A note has no separate sending step |
| **Payslip** | on the **first download**. Approving a run does not give anybody their slip — handing it over does |

The payslip rule is the odd one and it is the honest one: there is no issuing event in the
system, so the first time the file is served *is* the issue, and those exact bytes are kept
and served again ever after. docs/57 §6 noted that a reprint otherwise reflects the employee
record as it is today.

🔴 The payslip route renders **once**. The first version rendered a PDF to archive and
another to return — two browser round-trips for one request, and two separate renders of the
same document, so the file on record would not have been the file that went out.

## 3. 🔴 Archiving never fails the thing it archives

Rendering launches a browser. A company that cannot bill because a PDF renderer is unwell is
a far worse failure than one with no file on record, so:

- it runs **after** the transaction commits, never inside it — a render holds no database
  write lock
- it **never throws**. A failure is returned, not raised
- what was *not* archived is **named**: `unarchivedInvoices` lists every sent invoice with no
  copy, and the invoice screen says so on the one in front of you, in the words that matter —
  *"View document rebuilds it from today's data and today's template — close to what the
  client received, and not the same file."*

It also archives **once**. A second archive on a later send would store a different PDF
beside the first, and nothing would say which was sent. A *detached* copy does not count as
archived either — it was withdrawn.

The cost is real and is the price of the thing: issuing an invoice now takes about 740 ms
rather than 50 ms, and the integration suite went from 61 s to 126 s because every
`sendInvoice` in it renders a PDF.

## 4. The claim and its evidence, in one place

The expense screens have never had an attachment panel — only bills did (docs/38 §8,
docs/39 §5). So an expense claiming input credit and the document substantiating it lived in
different places, and nothing could say which claims had nothing behind them.

🔴 **Rule 36(1)** makes input credit claimable against a tax invoice the recipient *holds*;
s.16(2)(a) says it from the other side. An expense with ₹9,000 of ITC and no bill is a claim
that cannot be sustained when it is asked about — and the money has already been taken
against the GST payable.

There is now an expense detail screen with the panel, the list marks each one **no bill**, and
the page leads with the total at risk: *"₹12,600 of input credit has no bill behind it."*
A detached bill counts as no bill, for the same reason a detached archive does.

## 5. What looking found

- 🔴 Making the expense row a link swallowed the **reverse button** in its last column —
  `onRowHref` wraps every cell in an anchor, so "cancel" navigated away instead of asking
  why. The link is the description now.
- A script that calls `sendInvoice` no longer exits: the archive leaves a browser open and
  it holds the event loop. Anything short-lived has to call `closePdfBrowser()`.

## 6. Still open

- **Old documents are not back-filled.** Everything issued before today has no copy and is
  listed as such. A back-fill would render each one from the current template, which is
  precisely the document it is not — so if it is ever done it must be labelled a
  reconstruction, not an archive.
- **Statements are not archived**, and should not be: docs/58 statements are management
  documents, re-derivable by design, and a draft one re-read tomorrow *should* have moved.
- **Nothing emails any of it.** The archive is what was issued; sending is still a person
  attaching a file.
- **The capture flow still does not upload** (docs/30 §7). A receipt photographed on a phone
  is queued offline and never reaches storage, so the panel it would fill stays empty.
- **Attachments are not shown on receipts, invoices or payroll runs** — only bills, expenses,
  PAN cards and TDS certificates.
- Carried forward: service-item CRUD, the mobile tail, chases that nobody sends, note
  amendments (table 9C), refund vouchers, invoice-level GST reconciliation.
