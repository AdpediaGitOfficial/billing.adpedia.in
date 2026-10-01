# Invoice Format — Audit of the Current Template & Redesign

Reviewed: the five Prime invoices in `~/Desktop/prime/` (Nos. 10, 11, 11, 13, 25),
against the GST registration certificate and the Companies Act.

**New template:** [`templates/invoice/tax-invoice.html`](../templates/invoice/tax-invoice.html)
**Brand assets extracted:** `templates/invoice/assets/adpedia-logo.png`, `adpedia-wordmark.png`

---

## 1. What the current invoice already gets right

Genuinely — it's a good-looking document. Keep all of this:

- Strong, confident logo and the purple brand mark; the footer wordmark band is a nice touch
- Clean geometric typeface, generous type sizes
- Correct CGST/SGST split at 9% + 9% for a Kerala-to-Kerala supply
- Supplier and recipient GSTINs both present
- Bank details on the invoice
- Signed

The redesign keeps the visual identity intact. What changes is **compliance and structure**.

---

## 2. Two findings that need fixing regardless of this project

### 🔴 2.1 Invoice number 11 was issued twice

| File | Invoice No. | Date | Taxable value (derived from SGST) |
|---|---|---|---|
| `Prime-Milstone1_Invoice (1).pdf` | 10 | 19-02-2026 | ₹70,000 |
| `Prime-logo.pdf` | **11** | 19-02-2026 | ₹21,000 |
| `Prime-Milstone2_Invoice.pdf` | **11** | 16-03-2026 | ₹70,000 |
| `Prime-logo-2nd.pdf` | 13 | 21-03-2026 | ₹49,000 |
| `Prime-Milstone4_Invoice.pdf` | 25 | 16-09-2026 | ₹28,000 |

Two different invoices, a month apart, for different amounts, both numbered **11**.
Under Rule 46 of the CGST Rules an invoice number must be **unique within the financial
year**. Two live invoices sharing a number will not reconcile in GSTR-1, and your client
Click AR will have a matching problem in their GSTR-2B.

Also note **12 appears to be missing** between 11 and 13.

**Action:** ask your CA how to regularise this for FY 2025-26 — usually a credit note
against one of them and a re-issue under a fresh number. Don't quietly renumber a PDF
that has already gone to the client.

**In the new system this becomes impossible:** the invoice number is allocated by the
database inside the same transaction that creates the invoice (a Postgres sequence per
series per FY), never typed by a person and never assigned by whoever happens to be
editing the file that day.

### ✅ 2.2 Address mismatch — RESOLVED 30 Sep 2026

| Source | Address |
|---|---|
| Invoices (all five) | Room No: **VIII/308**, Chinnangath House… |
| **GST certificate REG-06** | **VIII/318**, Chinnangath House… |
| MCA incorporation certificate | C/O Prabhakaran C N, Chinnangath House, Thommana… |

A tax invoice must carry the supplier's address **as registered**. One digit, but it's
the kind of thing that gets picked up in a GST scrutiny and is trivially avoidable.

**Resolved: `VIII/318` is correct.** The GST certificate is right and the invoices were
wrong. No REG-14 amendment needed. The new template already uses VIII/318 and the company
profile is the single source, so this cannot drift again.

The five Prime invoices already sent to Click AR carry the wrong address. It's a minor
defect and normally nothing is done about it, but mention it to your CA once — if anything
is needed it would be a revised invoice, not a credit note.

---

## 3. Compliance gaps in the current format

Mandatory content for a tax invoice is set by **Rule 46, CGST Rules 2017**. Missing:

| # | Missing | Why it matters | Fixed in new template |
|---|---|---|---|
| 1 | **SAC code per line** | Mandatory; also feeds the HSN/SAC summary in GSTR-1 | ✅ SAC column + summary table |
| 2 | **Place of supply** | Mandatory; determines CGST+SGST vs IGST | ✅ In the meta strip |
| 3 | **Amount in words** | Mandatory | ✅ Below the HSN summary |
| 4 | **Rate per unit** | Mandatory where qty > 1; current table has Qty and Amount but no Rate | ✅ Rate + Taxable Value columns |
| 5 | **Reverse-charge declaration** | Mandatory — must state yes/no | ✅ In Terms |
| 6 | **CIN** | Companies Act s.12(3)(c): CIN must appear on all invoices and business letters | ✅ Supplier block + footer |
| 7 | **"Authorised Signatory"** | Current invoice says *"Prepared by"* — that isn't an attestation | ✅ "For Adpedia Films Private Limited / Authorised Signatory" |
| 8 | **Copy marking** | "Original for Recipient" / "Duplicate for Supplier" | ✅ Badge under the title |
| 9 | **Due date & payment terms** | Not legally mandatory, but you cannot chase an overdue invoice without one | ✅ Due date in meta, terms at foot |
| 10 | **Declaration line** | Standard practice, expected by many clients' AP teams | ✅ Added |

### Also worth fixing

| Issue | Detail |
|---|---|
| **Series doesn't reset per financial year** | ✅ **Resolved 30 Sep 2026.** Invoice 13 (21-03-2026, FY 25-26) and invoice 25 (16-09-2026, FY 26-27) were one continuous run. Decision: keep the count, adopt the FY-prefixed format — next invoice is **`ADP/26-27/0026`**, resetting to `ADP/27-28/0001` on 1 Apr 2027. Legacy numbers 1–25 get imported as reserved records so they can never be re-issued. See `01-company-profile.md` §5b. |
| **Date format** | `21- 03-2026` has a stray space, and `DD-MM-YYYY` is ambiguous to non-Indian clients. Use `21 Mar 2026`. |
| **Decimal inconsistency** | `49,000` next to `4,410.00`. Always two decimals on money. |
| **Empty filler row** | The blank second row in the items table makes the document look unfinished. |
| **"LOGO- Designing" heading** | This is really the project name. It should be a labelled field, not a floating heading. |
| **No TDS line** | Clients may deduct TDS u/s 194J/194C. Stating the expected deduction and net payable prevents short-payment disputes — and directly feeds the bank reconciliation matcher. |
| **Large vertical dead space** | Roughly a third of the page is empty, then content resumes at the bottom. The redesign uses a flex column so the footer anchors and the body breathes evenly. |

---

## 4. What the new template does

### Structure, top to bottom

```
  Logo                                    TAX INVOICE
                                     [Original for Recipient]
  ┌──────────┬──────────┬──────────┬────────────────┐
  │ Inv No.  │ Inv Date │ Due Date │ Place of Supply│
  └──────────┴──────────┴──────────┴────────────────┘
  ┌───────────────────────┐ ┌───────────────────────┐
  │ SUPPLIER              │ │ BILL TO      (tinted) │
  │ name / address        │ │ name / address        │
  │ GSTIN · PAN · CIN     │ │ GSTIN · State         │
  └───────────────────────┘ └───────────────────────┘
  ▐ Project · Your Ref/PO · Milestone          (brand band)
  ┌──┬──────────────────┬─────┬────┬───────┬──────────┐
  │ #│ Description      │ SAC │Qty │ Rate  │ Taxable  │
  └──┴──────────────────┴─────┴────┴───────┴──────────┘
  ┌─────────────────────────┐  ┌─────────────────────┐
  │ HSN/SAC summary         │  │ Taxable value       │
  │ Amount in words         │  │ CGST 9% / SGST 9%   │
  │                         │  │ Round off           │
  │                         │  │ ▐ INVOICE TOTAL     │
  │                         │  │ Less: TDS 194J      │
  │                         │  │ NET PAYABLE         │
  └─────────────────────────┘  └─────────────────────┘
  ┌────────────┬──────┬────────────────┐
  │ Bank + UPI │ QR   │ Authorised Sig │
  └────────────┴──────┴────────────────┘
  Terms & declarations
  ▐ adpedia wordmark · CIN · GSTIN · email      (brand band)
```

### Technical notes

- **A4 exactly** — `@page { size: A4; margin: 0 }`, 14mm internal padding
- **Multi-page safe** — `thead { display: table-header-group }` repeats the column
  headers on page 2; `tr { break-inside: avoid }` stops rows splitting
- **Every dynamic value carries `data-bind="path.to.field"`** so the template doubles
  as the binding contract when it's wired to the database
- **Brand colour `#493C7E`** sampled directly from your existing invoice, with
  `#5D5493` and a `#EFEDF6` tint derived from it
- **Poppins** from Google Fonts — closest match to your current wordmark; swap it for
  the real brand font once you tell me what it is
- **Intra vs inter-state** — the CGST/SGST rows and the IGST row are both present;
  the renderer shows one pair and hides the other based on place of supply
- **TDS block** is conditional; it only renders when the invoice has a TDS section set

### Still placeholder — need from you

- **UPI ID** → the QR box currently says "generated at render". Give me the UPI ID and
  I'll generate a real UPI intent QR (`upi://pay?pa=…&pn=…&am=…&tn=<invoice no>`),
  which also makes incoming payments self-identifying for the reconciler.
- **Signature image** → currently blank space above the rule
- **Email address** in the footer — I used `hello@adpedia.in` as a placeholder
- **Logo as SVG** — I extracted the PNG from your invoice PDF at 1200px, which is fine
  for print, but the original vector would be better
- **Client address for Click AR** — the current invoice has no pincode; I put a
  placeholder `680001`

---

## 5. Sample data used in the preview

Deliberately realistic, drawn from your actual business:

| Field | Value |
|---|---|
| Invoice | ADP/26-27/0026 (next after your current 25) |
| Client | Click AR Business Private Limited, Thrissur |
| Lines | Staff augmentation ₹70,000 (SAC 998314) + UI/UX revisions 2 × ₹7,500 (SAC 998391) |
| Taxable / CGST / SGST | ₹85,000 / ₹7,650 / ₹7,650 |
| Invoice total | ₹1,00,300 |
| TDS @10% u/s 194J | (₹8,500) |
| Net payable | ₹91,800 |

⚠️ **The SAC codes are my best guess and must be confirmed with your CA.** Your invoices
say *"Staff augmentation resource payment"*, and staff augmentation is sometimes
classified as **manpower supply (998519)** rather than **IT services (998314)** —
they are treated differently, and getting it wrong is a real exposure. This is the single
most important thing to check before the template goes live.

---

# 6. Revision 2 — changes from your feedback

| Your note | What changed |
|---|---|
| *"TDS maybe 10% and 2% both applicable depending on contract nature"* | TDS section is now a **per-invoice choice**, not a constant. Set `.tds-194j` (10%, professional/technical fees), `.tds-194c` (2%, contract work) or `.tds-none` on the sheet; the label and amount follow. Default comes from the customer master, overridable per invoice. |
| *"QR we don't have, so remove it"* | Removed. The payment block now spans wider and carries a **SWIFT** line for overseas remittance instead. Easy to reinstate later — the UPI QR would also make incoming payments self-identifying for the bank reconciler, so it's worth revisiting if you ever add a UPI ID. |
| *"logo uploaded in the folder, updated logo can use"* | Now using `ADPEDIA-logo.svg` — vector, scales cleanly to print. **Brand colour updated to `#4135AF`** (from the SVG) — the old invoices used `#493C7E`, a duller purple. The footer band reuses the same SVG knocked out to white. The PNGs I'd extracted from the old PDF are deleted. |
| *"A4 size too compact for printing"* | Opened up throughout: body type **9.2pt → 10pt**, item rows 8.8 → 9.6pt, page padding 14 → 15mm, and row/section spacing increased ~25%. Still one A4 page for a normal 1–4 line invoice. |
| *"IGST and CGST must apply depending on state"* | Built in as a **tax mode** (below). |
| *"international transactions have no GST — nil status also needed"* | Built in as the third tax mode (below). |

## 6.1 The three tax modes

One template, one class on `.sheet` decides everything — title, tax rows, HSN columns,
TDS visibility and the declarations.

| Mode | Class | When | Tax shown | TDS |
|---|---|---|---|---|
| **Intra-state** | `.mode-intra` | Place of supply = **Kerala (32)** | CGST 9% + SGST 9% | 194J or 194C |
| **Inter-state** | `.mode-inter` | Place of supply = any other Indian state | IGST 18% | 194J or 194C |
| **Export** | `.mode-export` | Recipient outside India | **Zero-rated — no GST** | **None** |

The renderer derives the mode; nobody picks it by hand:

```ts
function taxMode(company, customer) {
  if (customer.country !== 'IN')              return 'export'   // zero-rated
  if (customer.stateCode === company.stateCode) return 'intra'  // CGST + SGST
  return 'inter'                                                // IGST
}
```

**What export mode changes on the page**
- Title becomes **EXPORT INVOICE** rather than *Tax Invoice*
- Place of supply → *Outside India (96 – Other Territory)*
- Recipient GSTIN field → *Not applicable — overseas recipient*
- Tax line → *GST — Zero rated (export of services)* ₹0.00
- **TDS block disappears entirely** — foreign clients don't deduct Indian TDS
- The **LUT declaration** appears: *"Supply meant for export of services under Letter of
  Undertaking without payment of Integrated Tax. LUT ARN: …"* plus a note that the
  FIRC/BRC must be obtained on receipt
- Currency switches (the sample shows USD)

⚠️ **Export mode has two legal variants** and the template currently assumes the first:
1. **Under LUT/Bond, without payment of IGST** — what most services exporters do.
   **Requires a valid LUT filed for the financial year** (Form RFD-11). If Adpedia has
   no LUT on file, this option is not available to you.
2. **With payment of IGST, then claim refund** — charge IGST 18%, pay it, claim it back.

If you invoice overseas clients, **tell me whether you have a current LUT and its ARN**.
Without one, exporting zero-rated is not permitted and the invoice must carry IGST.

## 6.2 Preview files

Three rendered samples, same template:

- `inv-1-intra.html` — Click AR, Thrissur. Taxable ₹85,000 + CGST ₹7,650 + SGST ₹7,650
  = **₹1,00,300**, less TDS 194J @10% ₹8,500 → **net ₹91,800**
- `inv-2-inter.html` — Mumbai client. Taxable ₹85,000 + IGST 18% ₹15,300 = **₹1,00,300**,
  less TDS 194C @2% ₹1,700 → **net ₹98,600**
- `inv-3-export.html` — Dubai client. **USD 4,200**, zero-rated under LUT, no TDS

## 6.3 Still outstanding

1. **Signature image** — blank space above the rule, needs the authorised signatory's scan
2. **Which director signs?** Sheena or Abinas
3. **Email / website** for the footer (I removed the placeholder `hello@adpedia.in` in
   favour of CIN/GSTIN/PAN — say the word if you want contact details there instead)
4. **SWIFT code** — I used `AXISINBB`; confirm the exact 11-character code with your branch
5. **LUT ARN** if you export
6. **SAC codes** — still the open question from §5: staff augmentation may be
   `998314` (IT services) or `998519` (manpower supply). Confirm with your CA before go-live.

---

# 7. Revision 3

| Your note | What changed |
|---|---|
| *"sign updated at folder"* | `sign.png` processed → `templates/invoice/assets/signature.png` (700×282, transparent, cropped to the strokes). Placed above the signature rule with the signatory name beneath. |
| *"SAC code no need to mention"* | Added a `.hide-sac` mode — drops the SAC column **and** the HSN/SAC summary block. Applied by default. ⚠️ See §7.2. |
| *"Do you export — yes"* | Export mode confirmed as a live requirement, not hypothetical. ⚠️ Still blocked on the LUT ARN — see §7.3. |

## 7.1 The signature file needed repair

`sign.png` was broken in a way worth recording, because whatever produced it will produce
the same result again:

- 3024×4032 (12 MP) for an element that prints at ~40 mm wide
- **Alpha was the only usable channel.** The RGB channels contained a chunky blob artifact
  in dark green `(2, 90, 63)` — not the signature. The real strokes existed solely in the
  alpha channel (0.4% of pixels solid).
- Reading the RGB channels — the obvious approach — produced a solid black rectangle.

Processed by taking the alpha channel as the ink mask, cropping to its bounding box,
resampling to 700 px and recolouring to `#1A1922`. Final ink coverage 6.1%, which is the
right order of magnitude for a signature.

**If you re-export the signature**, a clean PNG with transparent background and dark
strokes (or a plain black-on-white scan) will skip all of this.

## 7.2 ⚠️ Removing the SAC code — one thing to check first

Done as asked, and it's a one-class change to put back. But so you're deciding with the
full picture:

Under **Notification 78/2020–Central Tax**, HSN/SAC on a tax invoice is mandatory by
turnover band:

| Aggregate turnover (preceding FY) | B2B invoices | B2C invoices |
|---|---|---|
| **Up to ₹5 crore** — Adpedia is here (~₹39L) | **4 digits mandatory** | Optional |
| Above ₹5 crore | 6 digits mandatory | 6 digits mandatory |

Click AR and your other Indian clients are GST-registered, so those are **B2B** and a
**4-digit SAC is required**. The 4-digit code is also where the `998314` vs `998519`
question actually bites — they differ at the fourth digit (`9983` professional/technical
services vs `9985` support services), so the ambiguity isn't avoided by shortening it.

**Suggestion:** keep `.hide-sac` on for now since it's blocking nothing, ask your CA
which of `9983`/`9985` applies to staff augmentation, then flip the class off. Export
invoices are unaffected either way.

## 7.3 🟡 LUT register — FY 2024-25 and FY 2025-26 on file, FY 2026-27 outstanding

Two ARNs supplied. Both decode cleanly — `AD` + `32` (Kerala) + `MMYY` + serial + check:

| ARN | Filed | Covers |
|---|---|---|
| `AD320324005917B` | 18/03/2024 | FY 2024-25 |
| `AD320325043063O` | 03/2025 | FY 2025-26 |

The filing pattern is consistent — early March each year, ahead of the new financial year.
That is exactly right.

**A LUT is valid for one financial year only** and must be re-filed before each new year
begins. Today is 30 September 2026 — **FY 2026-27**:

| Financial year | LUT on file | |
|---|---|---|
| FY 2024-25 | `AD320324005917B` | ✅ covered |
| FY 2025-26 | `AD320325043063O` | ✅ covered |
| **FY 2026-27** (current) | not provided | 🔴 **outstanding** |

Given you have filed every March without fail, an FY 2026-27 LUT was most likely filed
around **March 2026** — it would read `AD3203` + `26` + six digits. Check and send it and
this closes.

### What to do

1. **Check the portal for FY 2026-27.** *Services → User Services → View My Submitted LUTs*,
   select FY 2026-27. On your filing pattern it is probably there.
2. **If it is missing, file RFD-11 now.** Online, a few minutes, usually acknowledged
   immediately. Nothing should be exported zero-rated until it is in.
3. **Only if exports were raised since 1 April 2026 without it** does anything need
   unwinding — and even then there is relief. **CBIC Circular 37/11/2018** takes the
   position that the substantive benefit of zero-rating should not be denied for a
   procedural lapse, and delayed LUT filings have been accepted. Your CA's call, but the
   exposure is limited to this year's exports, not the earlier ones.

### Built into the template and the system

The LUT block on the export invoice now prints the **ARN, filing date and the financial
year it covers**, rather than a bare number — so an out-of-date LUT is visible on the
document instead of hidden in a portal.

There is also a guard. The renderer compares the invoice's financial year against the LUT
on file, and when they don't match the block turns red and prints:

> ⚠️ This LUT does not cover the invoice financial year — do not issue zero-rated until a
> current LUT is filed.

In the application this should be a **hard block on sending**, not a warning:

```ts
if (taxMode === 'export' && !company.lut.coversFy(invoice.fy)) {
  throw new BlockedError(
    'No valid LUT for ' + invoice.fy + '. File RFD-11, or raise this invoice with IGST.'
  )
}
```

Store LUTs as a **collection with validity**, not a single field — they are annual, they
expire silently, and a lapsed one is only noticed when someone goes looking:

```ts
company_luts: [
  { arn: 'AD320324005917B', filedOn: '2024-03-18', fy: '2024-25' },
  { arn: 'AD320325043063O', filedOn: '2025-03-??', fy: '2025-26' },
  // FY 2026-27 — outstanding
]
```

Add a **compliance-calendar reminder for early March each year** to re-file. It is the
kind of annual task that is missed precisely because it is annual.

## 7.4 One question about the signatory

The signature reads **Shinelal**, but the directors on the MCA record are
**Chinnangath Prabhakaran Sheena** and **Puliparambil Subair Abinas**.

That's perfectly workable — a company can authorise anyone to sign invoices — but it
should rest on a **board resolution** authorising Shinelal as signatory, kept on file.
Most clients never ask; an auditor or a GST officer might. Worth a five-minute
conversation with your CA rather than a surprise later.

I've put "Shinelal" under the signature line as the signatory name. Tell me the full name
as it should appear (and a designation, if you want one shown).
