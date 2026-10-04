# 67 · Master data you could not touch

**Status: done.** 906 tests (383 unit + 523 integration), typecheck and lint clean,
production build passes.

Two of the remaining one-screen gaps, built together because they are the same gap: data the
system reads every day and gave nobody a way to change. Building them turned up two defects
that had been impossible to reach precisely *because* there was no screen.

---

## 1. The service catalogue

Seeded since docs/34, used on every invoice, and adding a service meant editing the database.

- **Retired, never deleted.** An invoice line points at a service item, and a filed invoice's
  line has to keep pointing at something. Retiring it stops it being offered on a new invoice
  and leaves every old one intact — the same rule the whole system follows.
- 🔴 **The income account must be an income account.** Nothing downstream checks it: a service
  pointed at the bank would book every rupee of its revenue into the bank and leave the P&L
  short, silently, until somebody reconciled.
- **The SAC validator is finally called on input.** It has existed since docs/34 and nothing
  validated a code as it was entered — the same shape of gap docs/64 found in
  `validateInvoiceNumber`.
- **Changing a service changes no invoice.** A line copies the name, SAC, rate and GST rate the
  moment it is written. A test renames a service and re-renders an invoice that used it, to
  prove the document is unmoved.

## 2. 🔴 A field nothing could set is a field nothing exercises

`ServiceItem.incomeAccountId` holds an account **id**. `sendInvoice` passed it to
`revenueFromLines`, which wants a **code**:

```ts
incomeAccountCode: l.serviceItem?.incomeAccountId ?? null   // an id, labelled a code
```

That had been there since docs/34 and had never once fired. The catalogue had no screen, so
nothing could set the field — and the first invoice line that referenced a service with an
income account failed with **“Chart of accounts is missing: cmuu0oza1001…”**: the id,
presented as a code.

🔴 **And it was worse than latent.** The ten seeded services all *have* income accounts. What
kept it quiet is that the invoice form loaded the catalogue and used it only as a datalist:
picking a service copied its SAC and rate and threw away *which service it was*. No invoice
line has ever carried a `serviceItemId` — so every rupee of revenue posted to the fallback
4010, and the revenue sub-accounts in the chart (4030 Design, 4040 Film & Video Production)
could never receive anything. The P&L's revenue section has been one line since the beginning,
and the reason was two unexercised things meeting.

The line now carries the id, and 🔴 **clears it when the description is edited away** — a line
that kept a stale link would post revenue to the account of a service it no longer describes.

## 3. Company details, and a decision worth revisiting

docs/35 §6 refused to build this, and gave a good reason:

> *Editing company identity changes what appears on documents already issued, so it should
> arrive as a migration with an audit trail, not a text box.*

🔴 **docs/59 removed that reason.** Every invoice, note and payslip is now archived as the
bytes that went out, and the routes serve the archive rather than re-rendering — so correcting
the address today cannot rewrite the invoice a client received in May. The premise changed, so
the decision is revisited rather than inherited. The audit trail was the load-bearing half and
is kept: every change records its before and after in an append-only log.

🔴 **Half of it stays fixed, and the screen says which half and why on each row:**

| | |
|---|---|
| **PAN, GSTIN, CIN** | quoted in filed returns and on every challan — changing one makes GSTR-1 disagree with the portal |
| **Legal name** | the invoice series and every filed return are issued under it |
| **State code** | derives CGST+SGST vs IGST on *every future invoice*. A text box that silently re-heads the tax on everything sold after it is not an edit |

They are shown, not hidden: somebody looking for the field should find it and the reason
together, rather than hunting for something deliberately withheld.

## 4. What looking at it found

- The “Identity — fixed” card still listed **TAN and the trade name**, which the form above it
  had just made editable. Two things on one screen.
- Every row's explanation was rendered through the same `note` prop as the one real warning on
  the page, so five ordinary reasons came out amber with a ⚠ — and the warning that matters
  (the TAN was clipped in the source document and has never been verified) became
  indistinguishable from them. `why` and `note` are now different props with different styles,
  and the TAN warning moved to where the TAN is now edited.
- 🔴 The alert said **“Since docs/59 every document is archived…”** to a user. An internal
  document reference is the review marker's cousin: a pointer to something only the people who
  built this can follow.

## 5. 🔴 So the marker guard now covers doc references too

docs/61 made the review marker a test, after it had leaked four times. The same check —
comments stripped, then look at what is left — finds `(docs/48)` in a refusal a client's
accountant reads, `(docs/52)` in another, and `see docs/31` on a settings page. One of the
three was written **three modules earlier in this same session**, which is the argument for
the test rather than the care.

Two files are exempt by name: the storage driver and the e-invoice adapter throw at somebody
editing environment variables, who has the repository in front of them. Naming them makes the
judgement reviewed rather than assumed.

## 6. Still open

- **User invitations** remain unwired (docs/35 §6). Unlike company details, nothing has
  changed to make them safer: inviting a user is creating a credential, and it wants an email
  path and an expiry, which is a module rather than a field.
- **The invoice form does not offer the catalogue's GST rate**, only its SAC and default rate,
  so a 5% service still has to be re-rated by hand.
- **A retired service is still offered on a draft invoice already holding it.** The draft keeps
  what it had, which is right, but nothing says the service has since been retired.
- Carried forward: swipe gestures and the performance budget — the last two items on the list.
