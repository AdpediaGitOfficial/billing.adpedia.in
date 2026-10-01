# Adpedia — Company Profile & Seed Data

Source documents (verified 30 Sep 2026):
- PAN card (Income Tax Department)
- GST Registration Certificate, Form GST REG-06
- Certificate of Incorporation, MCA / Central Registration Centre
- Axis Bank account statement, 01/02/2026 – 30/09/2026

> These values seed the `companies`, `company_bank_accounts` and `invoice_series`
> tables. They belong in the database/env config, **not** hard-coded in the invoice
> template — the template reads them so a second entity can be added later.

---

## 1. Legal identity

| Field | Value |
|---|---|
| Legal name | **ADPEDIA FILMS PRIVATE LIMITED** |
| Trade name | ADPEDIA FILMS PRIVATE LIMITED |
| Constitution | Private Limited Company (limited by shares) |
| **CIN** | `U92190KL2021PTC068241` |
| **PAN** | `AAUCA9985H` |
| **TAN** | `CHNA09808A`  ⚠ *verify — last digits partly clipped in the source PDF* |
| **GSTIN** | `32AAUCA9985H1ZX` |
| Date of incorporation | 23 March 2021 |
| ROC | Central Registration Centre / RoC Kerala |
| Registered under | Companies Act, 2013 |

GSTIN consistency check: `32` (Kerala) + `AAUCA9985H` (PAN) + `1` (1st registration) +
`Z` + `X` (checksum) — internally consistent with the PAN card. ✓

## 2. GST registration

| Field | Value |
|---|---|
| Registration number | `32AAUCA9985H1ZX` |
| Type of registration | **Regular** (not composition) |
| Valid from | 11 November 2021 |
| Valid to | Not applicable (perpetual) |
| Certificate issued | 11 November 2021 |
| State / State code | **Kerala / 32** |
| Jurisdictional office | Commercial Tax Office, Irinjalakuda |
| Approving authority | Rabeena. E (Edathalasseri), State Tax Officer |
| Additional places of business | 0 |

**Tax logic this drives:**
- Client in **Kerala** → CGST 9% + SGST 9%
- Client **outside Kerala** → IGST 18%
- Client **outside India** → export of services, zero-rated (LUT needed — see open questions)
- Place of supply defaults to the client's state; overridable per invoice

## 3. Registered address (principal place of business)

✅ **Confirmed 30 Sep 2026: `VIII/318` is correct.** The GST certificate is right; the
five Prime invoices carrying `VIII/308` were wrong. Use this verbatim on tax invoices:

```
ADPEDIA FILMS PRIVATE LIMITED
VIII/318, Chinnangath House
Kaduppassery P.O., Irinjalakkuda
Thrissur, Kerala – 680683
India
```

MCA mailing address (slightly different wording — for ROC correspondence only):
```
C/O Prabhakaran C N, Chinnangath House,
Thommana, Kaduppassery-PO, Irinjalakuda,
Thrissur, Kerala, India, 680683
```

## 4. Directors / key managerial personnel

| Name | Designation | Resident of |
|---|---|---|
| CHINNANGATH PRABHAKARAN SHEENA | Director | Kerala |
| PULIPARAMBIL SUBAIR ABINAS | Director | Kerala |

→ **Authorised signatory for invoices: to be confirmed** (see open questions).

## 5. Bank account — Axis Bank

| Field | Value |
|---|---|
| Bank | Axis Bank Ltd |
| Branch | Chalakudy (CHAL KL), SOL 2174 |
| Account name | ADPEDIA FILMS PRIVATE LIMITED |
| Account number | `921020015185413` |
| Account type | Current Account — CA Business Select |
| **IFSC** | `UTIB0002174` |
| MICR | `680211006` |
| Currency | INR |
| Customer ID | 905708870 |

This is the account to print on invoices (plus a UPI ID once confirmed).

## 5b. Invoice numbering — confirmed

**Decision (30 Sep 2026): continue the existing count, adopt the FY-prefixed format.**
Next invoice is **`ADP/26-27/0026`**.

```ts
await prisma.invoiceSeries.create({ data: {
  companyId: adpedia.id,
  docType:  'TAX_INVOICE',
  prefix:   'ADP',
  pattern:  'ADP/{FY}/{SEQ:4}',   // -> ADP/26-27/0026
  fy:       '26-27',
  nextSeq:  26,
  resetOnFyChange: true,          // 1 Apr 2027 -> ADP/27-28/0001
}})
```

Two things this has to account for:

1. **Legacy numbers must be reserved.** Invoices `1`–`25` were issued in the old plain
   format, spanning FY 2025-26 *and* FY 2026-27 (No. 25 is dated 16-09-2026, which is
   FY 26-27). Import them as `status: 'IMPORTED'` records so the generator can never
   re-issue a number that already exists, and so GSTR-1 reconciliation covers the full year.
2. **FY 2026-27 will contain two formats** — the legacy plain numbers up to 25, then
   `ADP/26-27/0026` onward. That is legal: GST requires uniqueness and a consecutive
   series within the financial year, not a single format. Worth mentioning to your CA once
   so it isn't queried later.

At FY rollover the series resets to `ADP/27-28/0001`. Allocation happens inside the
database transaction that creates the invoice — never typed by a person.

## 6. Observed financial scale (from the Feb–Sep 2026 statement)

| Metric | Value |
|---|---|
| Period | 01/02/2026 – 30/09/2026 (8 months) |
| Transactions | **200** (≈25/month) |
| Total credits | ₹26,25,241 across **47** receipts |
| Total debits | ₹26,64,266 across **152** payments |
| Largest single credit | ₹3,70,000 |
| Opening / closing balance | ₹47,306 → ₹8,281 |

**What this tells us about the build:**
- Annualised inflow ≈ **₹39L** → **e-invoicing (IRN/QR) does not apply** (threshold is far
  above this). Keep the schema hook, skip the IRP integration entirely for now.
- Likely eligible for **QRMP** — quarterly GSTR-1/3B with monthly tax payment. Confirm with CA.
- ~25 bank lines/month means reconciliation is a **5-minute weekly task**, not a
  data-entry job. The swipe-card mobile UX is more than sufficient; no need for
  bulk-matching infrastructure in v1.
- 152 debits vs 47 credits → the pain is on the **payments/expense side**, not billing.
  Expense capture and vendor/contractor payments deserve more UX attention than I
  assumed in the first blueprint.

## 7. Seed record

```ts
// prisma/seed.ts — company profile
const adpedia = await prisma.company.create({
  data: {
    legalName:   'ADPEDIA FILMS PRIVATE LIMITED',
    tradeName:   'ADPEDIA FILMS PRIVATE LIMITED',
    constitution: 'PRIVATE_LIMITED',
    cin:   'U92190KL2021PTC068241',
    pan:   'AAUCA9985H',
    tan:   'CHNA09808A',            // TODO verify
    gstin: '32AAUCA9985H1ZX',
    gstRegistrationType: 'REGULAR',
    gstRegisteredFrom: new Date('2021-11-11'),
    incorporatedOn:    new Date('2021-03-23'),
    stateCode: '32',                // Kerala — drives CGST+SGST vs IGST
    registeredAddress: {
      line1: 'VIII/318, Chinnangath House',
      line2: 'Kaduppassery P.O., Irinjalakkuda',
      city: 'Thrissur', state: 'Kerala', stateCode: '32',
      pincode: '680683', country: 'India',
    },
    currencyDefault: 'INR',
    fyStartMonth: 4,                // April
    bankAccounts: { create: [{
      label: 'Axis Bank — Current',
      accountName: 'ADPEDIA FILMS PRIVATE LIMITED',
      accountNo:  '921020015185413',
      ifsc: 'UTIB0002174',
      micr: '680211006',
      bankName: 'Axis Bank Ltd',
      branch: 'Chalakudy (CHAL KL)',
      currency: 'INR',
      showOnInvoice: true, isDefault: true,
    }]},
  },
})
```

---

## 8. ⚠ Open questions — these change the build

### 8.1 What do you actually bill for? (blocks SAC codes + invoice template)

Your CIN class is **`92190` — other entertainment / motion picture activities**, and
the legal name is *Adpedia **Films*** Private Limited. But the brief you gave me was
software projects, websites, mobile apps and subcontracted development.

Those are **different SAC codes and different GST treatment**, e.g.:
- `998314` — IT design & development services
- `998361` — advertising services
- `999612` — motion picture / video production services
- `998387` — photography & videography

If Adpedia bills both ad-film production *and* software development from this one
entity, the invoice line items need a **per-service SAC** (which we'd build anyway),
plus a **service catalogue** master so staff pick the right one instead of typing it.
That also feeds the HSN/SAC summary GSTR-1 wants.

**Tell me your 3–6 most-billed services and I'll seed the catalogue with the right SACs.**

### 8.2 Still needed for the invoice PDF
1. ~~Logo files~~ — ✅ **supplied**: `ADPEDIA-logo.svg`, brand colour `#4135AF`. Still open: the *brand font* (template currently uses Poppins as the closest match).
2. **Authorised signatory** — which director signs? Signature image + company stamp (if used)
3. ~~UPI ID / payment QR~~ — ❌ **dropped at your request.** Payment block now carries SWIFT for overseas remittance instead.
4. ~~Invoice number format~~ — ✅ **answered: `ADP/26-27/0026`**, continuing the count. See §5b.
5. **Payment terms** default (15 days? 30?) and late-fee clause wording
6. Any **footer / declaration** text you use today

### 8.3 Tax / compliance
7. **LUT** — ✅ exports confirmed. On file: `AD320324005917B` (FY 2024-25),
   `AD320325043063O` (FY 2025-26). 🟡 Outstanding: the **FY 2026-27** ARN — likely filed
   ~March 2026. See `03-invoice-audit-and-redesign.md` §7.3.
8. **QRMP** — are you filing GST monthly or quarterly?
9. You hold a **TAN (`CHNA09808A`)**, so TDS deduction is a live obligation. The statement
   shows regular payments to individuals (Shinelal, Deepak Damodaran, Praveen C D,
   Nikhil M A, Akash Raveendran). **Are those salary (s.192), professional fees (194J),
   or contract payments (194C)?** They're treated completely differently. Are you
   deducting and depositing TDS on them today, or is the CA handling it offline?
10. **Directors' remuneration vs reimbursement** — several transfers look like director
    withdrawals; these need a deliberate account mapping or the P&L will be wrong

### 8.4 Migration
11. Are there **unpaid invoices outstanding today**, and any advances received? I need an
    **opening balance + cutoff date** so the ledger starts clean.
12. Where are the books now — Tally, Zoho Books, spreadsheets, or the CA's system?
