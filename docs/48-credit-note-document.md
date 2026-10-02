# 48 · The credit note as a document

**Status: done.** 593 tests (314 unit + 279 integration), typecheck and lint clean,
production build passes.

Docs/42 could issue a credit note. It could not hand one to the client, and it recovered GST
it was not entitled to.

---

## 1. 🔴 A credit note raised after the deadline was recovering GST anyway

This is the one that mattered.

s.34(2) lets a credit note reduce **output tax** only until 30 November following the
financial year of supply. The screen said so — *"the GST already paid cannot be recovered"* —
and the posting went ahead and recovered it: output CGST/SGST/IGST were debited, the note
landed in GSTR-1's `cdnr` table, and the books claimed a reduction the return cannot support.
The portal rejects the table that carries it, and the mismatch surfaces at reconciliation.

A note past the deadline now carries **no tax at all**:

| | Within s.34(2) | Past the deadline |
|---|---|---|
| Client is credited | 11,800 | **11,800** — unchanged |
| Output tax debited | 1,800 | **nil** |
| Revenue debited | 10,000 | **11,800** |
| In GSTR-1 `cdnr` | yes | **no** |

The client is credited the same gross either way; what changes is its composition. The tax
inside it stops being tax the company gets back and becomes a cost it bears, so the whole
amount comes off revenue — which is what the company actually gave back. `taxNotAdjusted`
keeps the row adding up (`taxableValue + taxNotAdjusted = grandTotal`) and keeps the cost
visible rather than buried.

🔴 The GSTR-1 builder filters to `gstAdjusted: true` and **says what it left out**, because a
table that silently drops rows is worse than one that explains itself.

> The alternative posting — revenue 10,000 and the 1,800 to its own expense line — is equally
> defensible and arguably clearer in the P&L. It needs an account that does not exist yet;
> worth raising with the CA before adding one.

## 2. The document — rule 53(1A)

`templates/credit-note/credit-note.html`, rendered by `render-credit-note.ts`, served at
`/api/credit-notes/[id]/document` (PDF by default, `?format=html` for debugging, exactly like
the invoice).

Rule 53(1A) fixes the contents, and the two fields people leave off are the ones the
recipient needs most: 🔴 **the number and date of the invoice it relates to**. Without them a
credit note is a payment the client's accounts team cannot allocate.

The template carries the invoice's design language and its lessons:

- **mode classes** drive the tax rows, with `!important` for the same specificity reason as
  docs/33 — without it a Kerala note prints an IGST line of 0.00
- **`.gst-adjusted` / `.gst-commercial`** switch the whole document between "tax credited" and
  "tax not credited", down to the colour of the copy mark
- **assets are inlined as data URIs** — a linked asset silently never reaches the PDF
- **the money column carries the invoice's currency**, so a USD export is not headed "(₹)"

🔴 The recipient's details come from the **invoice's own snapshot** (docs/41), not the live
customer row. A credit note that re-read the customer would show today's address against
yesterday's supply, and the pair that is meant to net out would disagree about who it was
issued to.

## 3. What rendering it found

🔴 Four things, and three of them were only visible in the output. The tests were green
throughout.

- **The s.34(2) declaration quoted the wrong invoice.** `invoice.number` is bound twice — the
  meta strip and the warning paragraph — and only the first was substituted. A document
  correctly headed against `ADP/26-27/0031` declared, in its one legally-loaded sentence,
  that the deadline had passed for `ADP/26-27/0026`.
- **The same bug sits in the invoice renderer**, on `company.legalName`: the supplier block
  was substituted, the *"For …"* line above the signature was not. It reads correctly today
  because the placeholder happens to be this company — which is exactly how a defect like
  that survives a careful look. Both renderers now replace every binding of a name, not the
  first.
- 🔴 **The deadline printed a day late.** `30 Nov 23:59:59 UTC` formatted in `Asia/Kolkata`
  is `01 Dec`. The document told the client the statutory limit was 1 December. Day markers
  are now formatted in UTC; instants are not affected, which is why every other date on the
  page was right.
- **The reason was printed twice**, once under the line and once in its own block.

## 4. The invoice page finally shows them

Credit notes were *"reachable from the invoice they credit"* — except nothing listed them.
Once issued, a note existed only in the ledger and in GSTR-1.

The invoice now lists each one with its reason, its document link, and a pill saying whether
GST was adjusted or it is a commercial credit. 🔴 And the totals card shows **Less: credit
notes** and **Net after credits** — a credited invoice read as fully owed, with the credit
notes listed further down the page and nothing connecting them to the figure a reader takes
away.

## 5. Still open

- **Debit notes** (s.34(3), increasing the value) remain unbuilt — the mirror image, and
  rarer.
- **No credit-note list screen.** They are reachable from their invoice, which is the only
  place they belong, but there is no register of them as a series.
- **The document is not emailed or stored.** It renders on demand; nothing attaches it to the
  note (docs/38 could) or sends it to the client.
- **A credit note cannot be cancelled.** Same shape as the set-off in docs/46 — it posts a
  journal, so the docs/40 reversal pattern applies, but a note already sent to a client wants
  its own thinking.
- Carried forward: vendor and project edit pages, the unmatch button, payroll and challan
  cancellation.
