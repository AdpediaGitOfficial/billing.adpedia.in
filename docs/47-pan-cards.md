# 47 · PAN cards on file, and no online verification

**Status: done.** 580 tests (314 unit + 266 integration), typecheck and lint clean,
production build passes.

The ask was a manual PAN card upload, with no online verification. Building it found that the
*absence* of online verification was already costing money, because the TDS rate was keyed
off a check this system was never going to make.

---

## 1. 🔴 The register was over-deducting, permanently

`savePans` — the service behind the PAN register, the documented place to clear the handover's
first blocker — wrote this:

```ts
// 🔴 panVerified stays FALSE. Only a portal check may set it, and typing a PAN in is
// not a portal check.
await prisma.vendor.update({ where: { id }, data: { pan, panVerified: false } })
```

and `tds-resolver` reads:

```ts
if (!isValidPanFormat(deductee.pan) || !deductee.panVerified) → s.206AA, 20%
```

Nothing in the system could ever set `panVerified` true except the vendor form, which set it
from **format alone**. So the same PAN produced two different answers depending on which
screen it was typed into, and every PAN collected through the register left that payee at
**20% for good**. For a freelancer on 194J that is 10% of every invoice, recoverable only by
filing a return and waiting for a refund.

### What the section actually says

s.206AA applies where the deductee **has not furnished** their PAN to the deductor. It does
not require the deductor to verify it against anything. A number the payee gave us is
furnished; that is the test, and it is now the test the code applies.

🔴 `panVerified` therefore means **furnished and format-valid**, and the schema says so. What
stands behind it is a separate field.

## 2. `panEvidence` — what we actually hold

```
NONE          nothing
DECLARED      the payee gave us the number — email, invoice, phone
CARD_ON_FILE  a copy of the card is attached, and a person confirmed it matches
```

On `Vendor` and on `Employee`, with `panEvidenceAt` and `panEvidenceById` — because
confirming is somebody's judgement, and it should carry their name.

🔴 The evidence level **never changes the rate**. Withdrawing a confirmation drops
`CARD_ON_FILE` back to `DECLARED` and leaves the number, the file and the deduction exactly
where they were: the payee still furnished the PAN, so s.206AA is still satisfied, and a
scanning problem is not a reason to start withholding 20% from someone.

## 3. The upload

Reuses the document storage from `docs/38` — a new `AttachmentKind.PAN_CARD`, filed against
`Employee`/`Vendor` by id. Which means it inherits everything that module decided:

- **magic bytes are checked** against the declared content type, so a file claiming to be a
  JPEG and containing something else is refused
- **SVG and HTML are not accepted** at all
- **nothing is ever served inline** — `content-disposition: attachment`, `nosniff`, and a
  `default-src 'none'; sandbox` CSP. An identity document is the last thing that should
  render in this origin.
- **detaching is soft** — the file is kept

🔴 One thing is new: the upload route resolves the party **in this company** before storing a
`PAN_CARD`. The entity id comes from the browser, and for a generic receipt a bad id is
untidy; for somebody's identity document it is a filing cabinet with no owner.

HEIC is accepted, because a PAN card arrives as a phone photo at least as often as a scan.

## 4. Confirming is a human act

The system has an image and a string. Reading the one to check the other is exactly the kind
of guess that puts a stranger's PAN in a TDS return, so it does not try: a person opens the
card, reads the number, and presses **It matches**. The button records who and when.

It refuses when there is nothing to confirm *against* — no PAN recorded, a malformed one, an
employee whose PAN's 4th character is not `P` — and when no card is attached, because
confirming then would record evidence that does not exist.

## 5. What the register says now

The portal nag is gone. In its place:

| | |
|---|---|
| **issues** | something is **wrong** — malformed PAN, a duplicate across two parties, a rate being over-deducted |
| **chases** | paperwork still to collect — no card on file, or a card nobody has confirmed |

🔴 Separating them was not cosmetic. Rendering the page put an amber **check** against
vendors whose rate was already right and whose only sin was that the card had not arrived
yet — and a list where everything is flagged is a list nobody reads.

What the card cannot do is prove the PAN exists. Nothing available here can. A wrong but
well-formed number is reported against a stranger, never reaches the real payee's 26AS, and
surfaces as a short-deduction notice on TRACES after the 26Q is filed. Comparing the card
against the number is what catches it first, and the page says exactly that.

## 6. What rendering it found

- 🔴 **The PAN input collapsed to 60px on a phone.** The new card column made three cells
  share 375px, leaving the box too narrow to type ten characters into — the one thing the
  screen exists for. Rows now stack below `sm`.
- **"check" on rows that were fine** — §5.
- The copy on `/vendors`, the new-bill form, the dashboard and the TDS resolver all said
  *"no verified PAN"*. They now say *"no PAN on file"*, which is both the statutory test and
  what the user can do something about.

## 7. Still open

- **Nobody is told when a card is missing.** The register lists them; nothing emails the
  freelancer to ask. The compliance calendar would be the natural place.
- **The card is never read.** OCR exists in this codebase for receipts (`docs/30`) and could
  propose the number from the image — but a PAN proposed by OCR and confirmed by nobody is
  worse than one typed by hand, so it would have to keep the human confirmation step.
- **No expiry or re-ask.** A PAN does not expire, but it can be surrendered or made
  inoperative under rule 114AAA where it is not linked to Aadhaar — and an inoperative PAN
  attracts the 20% rate as if none had been furnished. Nothing here tracks that, and nothing
  available to this system could.
- Carried forward: credit-note PDF, debit notes, vendor and project edit pages, the unmatch
  button, payroll and challan cancellation.
