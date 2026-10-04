# 75 · The IRN on the document, and the mock that must never reach one

**Status: done.** 998 tests (411 unit + 587 integration), typecheck and lint clean,
production build passes.

`docs/31 §8`: *"IRN/QR on the PDF template — the fields persist, the template does not render
them yet. Pointless until there is a real IRN."*

Pointless, and worse than pointless until one thing was fixed first: there was no way to tell a
real IRN from a fake one.

---

## 1. 🔴 A mock registration is indistinguishable from a real one

`registerEInvoice` writes `irn`, `ackNo`, `ackDate` and `signedQr`. `irpAdapter()` returns the
mock unless `IRP_MODE=live`, and the mock produces:

- an **IRN** that is a SHA-256 of the right inputs — 64 hex characters, exactly the right shape;
- a **`signedQr`** that is base64 of `{"mock":true,…}`.

Both land in the same four columns a real IRP would fill. The only record of which had happened
was a line in the audit log, which nothing downstream reads.

Print that and the document looks exactly like an e-invoice and verifies as nothing — a forgery
nobody set out to make, discovered by whoever first scans it. So the column came first:
`Invoice.irpSource` records the adapter's own name at registration, and the migration backfills
every existing IRN as the mock's, because this system has never had a live client (`docs/31 §6`
makes it a deliberate non-goal) so any IRN on file came from there. Leaving them null would make
"unknown" and "real" the same shape to the renderer, which is the thing the column exists to
prevent.

🔴 **The renderer's test is an allowlist, not `!== 'MOCK…'`.** An adapter added later and
forgotten would otherwise print by default, which is the wrong direction for this to fail in.

## 2. 🔴 The QR is the IRP's own payload, printed verbatim

Rule 46(r) wants the code the portal returned. Encoding the invoice's own particulars would
produce something that scans, looks official, and was signed by nobody.

So the image is `QRCode.toDataURL(invoice.signedQr)` and nothing else, and a test asserts the
rendered data URI equals an encoding of `signedQr` — not that *a* QR is present. If the source
ever drifts to "the invoice number and total", that test fails.

A real signed QR is a JWS of several hundred bytes, which needs a dense symbol; it is printed at
22mm so a phone can read it off paper.

## 3. 🔴 Removed entirely, not left blank

Adpedia is below the ₹5 Cr threshold, so its invoices are **not e-invoices at all**. An empty
IRN box on one is a claim that it should have had an IRN, and the block is deleted from the
document rather than rendered empty.

🔴 **Delimited by comments, not matched structurally.** The first version removed the block with
a regex that counted closing tags through nested markup — one edit away from taking the
signature with it, and the failure mode is a document that renders and is quietly missing
something. `<!--einvoice:start--> … <!--einvoice:end-->` says what it means.

## 4. 🔴 One grid item, not two

`.payline` is a two-column grid: payment details, then the signature. Adding the e-invoice block
as a third child pushed the signature onto its own row across the full page width — a changed
document for every invoice, including the ones with no IRN at all.

Found by rendering it and looking, which is the only way this class of thing is ever found. The
block and the signature now share one column.

## 5. What this leaves

- **The live IRP client is still not implemented**, on purpose (`docs/31 §6`). Everything here
  is now ready for one, and none of it can be exercised against a real IRP until it exists —
  which is stated rather than hidden, because `docs/00 §6` says what unexercised code costs.
- **`irpSource` is the adapter's `name` string.** A rename would silently stop matching the
  allowlist, which fails safe (nothing prints) but fails silently. A stable code would be
  better than a display name.
- Carried forward from `docs/00 §7`: server-side pagination on the three 100-row lists,
  removing a user and changing a role, and the ITR/GSTR-9 financial-year question from
  `docs/72 §2`.
