# Expense & Payment Categories — Ledger, GST and TDS Mapping

Built from the six payment types you listed, cross-checked against the Axis statement
(152 outward payments, Feb–Sep 2026).

> Every rate and threshold below is an **illustrative default to confirm with your CA**.
> They live in effective-dated config tables, never hard-coded. Same rule as
> `02-recon-tds-mobile-pdf.md`.

---

## 1. The mapping table

| Category | Ledger account | GST on the bill | ITC | TDS | Notes |
|---|---|---|---|---|---|
| **Salary** | Salary & Wages (Expense) | None — employment is outside GST | — | **s.192**, average slab rate | Monthly payroll run → Salary Payable → payment. Feeds project staff cost. |
| **Payment for vendors** | Project Cost / Professional Fees | 18% if vendor registered | ✅ Yes | **194J 10%** or **194C 1–2%** | Depends on contract nature. Per-vendor default, overridable per bill. |
| **Monthly server payments** | Cloud & Hosting | ⚠️ **Depends on supplier country** | ✅ Yes | Usually none if Indian | 🔴 See §2 — this is the one to get right. |
| **Internet charges** | Internet & Telephone | 18% from the ISP | ✅ Yes | **Generally none** | Standard broadband/telecom is not a 194J technical service. |
| **Domain renewals** | Software & Subscriptions | ⚠️ **Depends on registrar** | ✅ Yes | Usually none if Indian | 🔴 See §2 — GoDaddy/Namecheap are often foreign-billed. |
| **Travelling expenses** | Travel & Conveyance | Mixed: 5% air, 12–18% hotel | ⚠️ **Partly blocked** | 194C only via a contracted agency | See §3 — food is blocked ITC. |

---

## 2. ✅ Servers and domains — Indian-billed, no reverse charge

**Confirmed 30 Sep 2026: AWS bills from AWS India, domains from GoDaddy India.**

Both are Indian entities with a GSTIN, so both are **ordinary domestic purchases**:

| Service | Billed by | GST on the invoice | Treatment |
|---|---|---|---|
| Cloud / servers | **AWS India Pvt Ltd** | 18% (IGST — they're outside Kerala) | Normal purchase, **full ITC** |
| Domain renewals | **GoDaddy India** | 18% | Normal purchase, **full ITC** |

**No reverse charge, no self-invoicing, no cash RCM payment.** That removes the largest
compliance item that was open in this list.

### ⚠️ But check one thing — is Adpedia's GSTIN on those invoices?

ITC is only claimable if the invoice is **raised to Adpedia's GSTIN**. Both providers
require you to enter it explicitly, and both default to a plain consumer invoice if you
don't:

- **AWS** — Billing console → *Tax Settings* → add GSTIN `32AAUCA9985H1ZX` and the
  registered address
- **GoDaddy** — account profile → GST / business details

If either account was opened personally and never had the GSTIN added, **every rupee of
GST paid on it is lost** — not deferred, lost. On a spend of ₹50,000–₹1,00,000 a year
across both, that is roughly **₹9,000–₹18,000 of ITC a year** going out of the door quietly.

It's a five-minute fix and it only works **going forward** — past invoices generally can't
be reissued with a GSTIN after the fact. Worth doing this week rather than next quarter.

Also confirm the credits actually appear in **GSTR-2B**. Both suppliers file reliably, so
they should, but ITC is only claimable once it shows there.

### 🔴 DigitalOcean is the exception — reverse charge does apply

**DigitalOcean LLC is a US company with no Indian GST registration.** It is not in the
same category as AWS India and GoDaddy India.

Under the **OIDAR** rules, a foreign supplier of online services to India is treated by
the status of the recipient:

| Recipient | Who pays GST |
|---|---|
| **Registered business (B2B)** — Adpedia | 🔴 **The recipient, under reverse charge @18% IGST** |
| Unregistered consumer (B2C) | The foreign supplier, who must register under OIDAR |

Adpedia is registered, so DigitalOcean will **not** charge GST on the invoice — and
Adpedia must self-account for **IGST @18% under reverse charge**. (This is exactly why
DigitalOcean asks Indian customers for a GSTIN: to classify the account as B2B and stop
charging GST.)

So the mapping is now:

| Service | Billed by | GST on invoice | Treatment |
|---|---|---|---|
| AWS | AWS India Pvt Ltd | 18% | Normal purchase, **full ITC** |
| Domains | GoDaddy India | 18% | Normal purchase, **full ITC** |
| **DigitalOcean** | **DigitalOcean LLC (US)** | **none** | 🔴 **RCM — pay IGST in cash, claim ITC back** |

Net cost is still nil **if it is done**: pay the RCM, claim it as ITC in the same GSTR-3B.
It becomes a liability with interest only if it is ignored. A **self-invoice** under
s.31(3)(f) is required for each one.

*Worth confirming against an actual DO invoice — check whether it shows an Indian GSTIN
and whether any GST is charged. If it does show one, it moves into the AWS/GoDaddy row.*

### 🔴 But none of these are paid from the Axis account

Searching the full Feb–Sep 2026 statement for `aws`, `amazon`, `digitalocean`, `godaddy`,
`cloudflare`, `namecheap`, `google`, `vercel` and card/POS transactions returns **nothing**.
The only software trace in 200 transactions is the remark `Figmasub` on a personal transfer.

So the cloud and domain spend is **not going through this bank account**. It is on a card,
or on someone's personal account. That matters more than the RCM question:

1. **If those accounts are in a personal name, there is no ITC at all** — the invoice isn't
   raised to Adpedia's GSTIN, so the GST paid is simply lost, not deferred.
2. **The RCM liability on DigitalOcean still sits with Adpedia** regardless of whose card
   paid it, if the service is used for the business.
3. **The expense may not be in the books at all**, which understates cost and overstates
   project margins.

**Action:** confirm how AWS, DigitalOcean and GoDaddy are actually paid, and whose name the
accounts are in. If they are personal, move the billing to the company with Adpedia's GSTIN
registered — it only works going forward, so the sooner the better.

### Keep the RCM machinery — it is needed now, not hypothetically

`is_foreign_supplier` → `rcm_applicable` is a live requirement because of DigitalOcean, and
will apply again to Figma, Vercel, Cloudflare, Namecheap, LinkedIn, and Meta/Google ads
billed from Ireland. The flag is set once per vendor from whether their invoice shows a
GSTIN, and self-invoice generation runs through the same PDF pipeline as everything else.

## 3. Travelling expenses — ITC is partly blocked

Travel is the category where people over-claim ITC and it gets reversed at audit.
Under **s.17(5)**, some of it is blocked:

| Component | GST | ITC |
|---|---|---|
| Air ticket — economy | 5% | ✅ Claimable for business travel |
| Air ticket — business class | 12% | ✅ Claimable |
| Hotel accommodation | 12% / 18% by tariff | ✅ Claimable **if the hotel is in your state, or you have a GSTIN there** |
| **Food & beverages, restaurant bills** | 5% | ❌ **Blocked u/s 17(5)(b)** |
| Outdoor catering | 5% | ❌ Blocked |
| Cab / taxi (Uber, Ola) | 5% | ❌ Generally blocked for passenger transport |
| Train — AC | 5% | ✅ Claimable |

The out-of-state hotel point catches people out: GST on a Bengaluru hotel is **CGST+SGST
of Karnataka**, and Adpedia has no Karnataka registration, so that credit is **not
claimable**. Book it as cost, don't try to claim it.

**System behaviour:** the expense form should set `itc_eligible` automatically from the
category, and require an override reason to change it. Nobody should be deciding this
per receipt from memory.

**TDS on travel:** generally none. It only arises if you have a **contract with a travel
agency** — then 194C applies to the agency's service fee, not to the ticket cost passed through.

---

## 4. Vendor payments — the 194J vs 194C split

The two you'll actually use:

| | **194J — 10%** | **194C — 1% / 2%** |
|---|---|---|
| For | Professional or technical services delivered on the vendor's own judgement | Carrying out work to your specification under a contract |
| Typical | Freelance developer, designer, CA, lawyer, consultant | Subcontracted agency, production crew, fabrication, AMC |
| Rate | 10% (2% if *fees for technical services*) | 1% individual/HUF, **2% company/firm** |
| Threshold | Annual, per vendor per section | Single-payment **and** annual aggregate |

Two mechanics the system must enforce, both covered in `02-recon-tds-mobile-pdf.md` §B2:

- **Threshold crossing is retrospective.** When a vendor's cumulative FY payments cross
  the limit on their third bill, TDS is due on the **whole amount**, not just the excess.
  Blocking prompt at bill entry, not a March discovery.
- **TDS is computed on taxable value, excluding GST** where GST is shown separately
  (CBDT Circular 23/2017).

---

## 5. Seed data

```ts
// expense_categories — drives account, GST and TDS defaults on every expense form
[
  { code:'SALARY',    name:'Salary & Wages',        account:'5100', gst:'NONE',
    itc:false, tds:'192',  rcmPossible:false },
  { code:'VENDOR',    name:'Vendor / Subcontract',  account:'5200', gst:'STANDARD_18',
    itc:true,  tds:'194J', tdsAlt:'194C', rcmPossible:true },
  { code:'CLOUD',     name:'Cloud & Hosting',       account:'5310', gst:'CHECK_SUPPLIER',
    itc:true,  tds:null,   rcmPossible:true,  recurring:true },
  { code:'INTERNET',  name:'Internet & Telephone',  account:'5320', gst:'STANDARD_18',
    itc:true,  tds:null,   rcmPossible:false, recurring:true },
  { code:'DOMAIN',    name:'Domains & Software',    account:'5330', gst:'CHECK_SUPPLIER',
    itc:true,  tds:null,   rcmPossible:true,  recurring:true },
  { code:'TRAVEL',    name:'Travel & Conveyance',   account:'5400', gst:'MIXED',
    itc:'PARTIAL', tds:null, rcmPossible:false, blockedComponents:['FOOD','CAB'] },
]
```

`CHECK_SUPPLIER` is deliberate — the category cannot decide it, only the supplier's
GSTIN can. The expense form asks once per vendor and remembers.

**Recurring expenses** (`recurring: true`) get their own treatment: servers, internet and
domains repeat monthly or annually, so the system should template them, predict the next
occurrence, and flag a missed one. Domain renewals in particular are annual and easy to
lose — a lapsed domain is an outage.

---

## 6. ✅ Payee classification — complete, confirmed 30 Sep 2026

### Payroll — 4 people, s.192

| Person | Role | TDS | Return |
|---|---|---|---|
| **Shinelal** | Director — remuneration as salary | **s.192**, average slab rate | 24Q |
| **Akash Raveendran** | Employee | **s.192** | 24Q |
| **Deepak Damodaran** | Employee | **s.192** | 24Q |
| **Kiran N S** | Employee | **s.192** | 24Q |

Consistent with the narration remarks — `Sal`, `Salary`, `Salaryfo`, `Overtime` appear
against all three employees.

**What this means for the build:** payroll is a real module, not a single director entry.
Salary structure, monthly run, Form 16, and — since Adpedia does software delivery —
**staff cost allocation across projects**, which is what makes project margin real rather
than notional.

**Statutory thresholds at 4 employees (confirm with your CA):**
- **EPF** — mandatory at 20+ employees. Not applicable; voluntary coverage possible.
- **ESI** — mandatory at 10+ employees. Not applicable.
- **Kerala profession tax** — applies by salary slab regardless of headcount, paid
  half-yearly to the local body. **This one does apply.** Easily missed.

### Freelancers — 9 people, s.194J @10%

| Person | Narration remark |
|---|---|
| **Nikhil M A** | — |
| **Praveen C D** | — |
| **Soniya Jimmy** | `Beadia pa`, `Octobe rh` |
| **Aswin P V** | `Des`, `Old`, `Jyo` |
| **Varsha Unnikrishnan** | `TD` |
| **Maneesh Unnikuttan** | `A` |
| **Muhammed Saheed M K** | `Designfe` — design fee |
| **Prajitha** | — |
| **Vinitha** | — |

Each needs, before the next payment run:
1. **PAN on file.** Without it s.206AA forces **20%** instead of 10%.
2. **Cumulative FY tracking per person.** Crossing the annual threshold makes TDS due
   retrospectively on the **whole** amount, not the excess — the blocking prompt in
   `02-recon-tds-mobile-pdf.md` §B2.
3. **GST status.** If any are registered, they charge 18% and Adpedia claims ITC.

### Entities

| Entity | Nature | Treatment |
|---|---|---|
| **Exalture Software Lab** | Vendor **and** customer | 194C @2% or 194J @10% — see below. Two separate ledgers. |
| **Blue Light Cable Vision** | Internet provider | No TDS. 18% GST → **full ITC**. |
| **Afrizon Crenergy Trade Pte** | ⚠️ **Foreign — see §6.1** | s.195 + RCM. |

**Exalture** — a software lab doing development work. If they deliver to Adpedia's written
specification under a contract, it's **194C @2%** (they're a firm/company, so 2%, not 1%).
If they exercise their own professional or technical judgement, it's **194J @10%**. Worth
settling explicitly rather than by default, since they appear to be a significant vendor.

### 6.1 🔴 Afrizon Crenergy Trade **Pte** — a foreign entity

"Pte" is a **Singapore** company suffix. If Adpedia paid them for services, three
obligations arise that do not apply to any domestic vendor:

1. **TDS u/s 195** — payment to a non-resident. Rate per the **India–Singapore DTAA**,
   which usually requires a **Tax Residency Certificate** and **Form 10F** from them to
   access the treaty rate. Without those, the domestic rate applies.
2. **Form 15CA / 15CB** — a CA-certified 15CB and an online 15CA are generally required
   **before** the remittance is made, not after.
3. **GST reverse charge** — import of services, IGST @18% payable in cash and reclaimable
   as ITC, with a self-invoice under s.31(3)(f). Same machinery as DigitalOcean.

The amount involved appears small, but the compliance obligations attach regardless of
size, and 15CA/15CB is a *before-payment* requirement. **Please confirm what this payment
was for** — if it was a goods purchase or a refund rather than a service, the treatment
differs. Worth raising with your CA either way.

### 6.2 Summary — what the ledger needs

| Group | Count | Section | Quarterly return | Certificate |
|---|---:|---|---|---|
| Payroll (incl. director) | 4 | s.192 | **24Q** | Form 16 |
| Freelancers | 9 | s.194J @10% | **26Q** | Form 16A |
| Domestic vendors | 2 | 194C / 194J / none | 26Q | Form 16A |
| Foreign vendors | 1+ | s.195 + RCM | 27Q | Form 16A |

That is **four TDS return types**, which is more than the single 26Q I had assumed.
It is entirely normal at this size — but it needs to be in the compliance calendar from
day one, not discovered at the first filing deadline.

## 7. ✅ Shinelal — director remuneration as salary (s.192)

**Confirmed 30 Sep 2026.** Of the three possible treatments, this is Option A — and it is
the cleanest of them:

- ✅ **No GST.** Circular 140/10/2020: remuneration declared as salary and subject to TDS
  u/s 192 is *not* liable to GST. The ~₹3.09 lakh of reverse charge that Option B would
  have triggered **does not arise**.
- ✅ **No deemed-dividend exposure.** s.2(22)(e) applies to loans and advances, not to
  remuneration — so the Option C risk is off the table.
- **P&L expense**, deductible for the company, under *Director's Remuneration*.
- TDS under **s.192** at the average slab rate, **Form 24Q** quarterly, **Form 16** by 15 June.

### ⚠️ Per-payee totals could NOT be established from the PDF statement

I attempted this three ways — name-proximity matching, narration-grammar parsing, and
parsing after stripping the interleaved layout tokens. **All three reproduce the statement's
control total of ₹26,64,266 exactly, and all three disagree on how it splits by payee.**
For Shinelal alone they returned ₹17,14,653 / ₹8,07,540 / ₹1,97,884.

The cause is the PDF text layer: names wrap across the column boundary, so a single
narration is emitted as `INB/NEFT/AXODH16191814546/DEEPA` … `K DAMODARAN/STATE BANK OF
INDIA`, interleaved with dates, balances and branch strings from neighbouring rows. Any
regex over it mis-attributes, and the third pass still left 38 debits (₹4,54,800)
unresolved plus duplicate variants like `SHINELAL` / `SHINEL AL`.

**🔴 Any per-payee figure quoted earlier in this project should be disregarded**, including
the ₹17.15 lakh attributed to Shinelal and the ₹81,822 TDS estimate derived from an
₹8.18 lakh freelancer base. Those rested on the first method and it does not hold up.

**To get exact numbers: export the same period from Axis internet banking as `.xls` or
`.csv`.** The columns are discrete there, attribution becomes trivial and exact, and the
result can be trusted for a TDS computation. This is the same conclusion as
`02-recon-tds-mobile-pdf.md` §H1, now demonstrated rather than predicted.

### What the statement does establish reliably

**Control totals** (identical across all three methods):

| | Amount | Txns |
|---|---:|---:|
| Total debits | ₹26,64,266 | 152 |
| Total credits | ₹26,05,359+ | 47 |
| Bank charges & GST thereon | ~₹40,620 | 27 |

**The counterparty roster** — names are reliable even where the amounts are not:

| Counterparty | Remarks observed in the narration | Likely |
|---|---|---|
| **Shinelal** | — | Director (confirmed) |
| **Akash Raveendran** | `Sal` ×5 | ⚠️ **Salary** |
| **Deepak Damodaran** | `Sal` ×4 | ⚠️ **Salary** |
| **Kiran N S** | `Salary`, `Salaryfo`, `Overtime` | ⚠️ **Salary** |
| **Nikhil M A** | — | ? |
| **Praveen C D** | — | ? |
| **Soniya Jimmy** | `Beadia pa`, `Octobe rh` | ? |
| **Aswin P V** | `Des`, `Old`, `Jyo` | ? |
| **Varsha Unnikrishnan** | `TD` | ? |
| **Maneesh Unnikuttan** | `A` | ? |
| **Muhammed Saheed M K** | `Designfe` (design fee) | ? |
| **Prajitha**, **Vinitha** | — | ? |
| **Exalture Software Lab** | `Superap`, `Develop` | Vendor — see below |
| **Blue Light Cable Vision** | `Inte` (internet) | Internet provider |
| **Afrizon Crenergy Trade Pte** | — | ? (Pte = Singapore entity) |

### 🔴 Three of the "freelancers" are being paid as salary

`Akash Raveendran`, `Deepak Damodaran` and `Kiran N S` carry remarks of **`Sal`, `Salary`,
`Salaryfo` and `Overtime`** — written by whoever made the payments. That is inconsistent
with the earlier instruction that everyone other than Shinelal is a freelancer.

The distinction is not cosmetic:

| | Employee | Freelancer |
|---|---|---|
| TDS | **s.192**, slab rate, Form 24Q | **s.194J**, 10%, Form 26Q |
| Return | 24Q | 26Q |
| Year-end certificate | Form 16 | Form 16A |
| GST | None | 18% if they're registered |
| Also triggers | PF/ESI thresholds, profession tax | Threshold tracking per vendor |

**Please confirm which they are.** If they're employees, they belong in payroll with
monthly s.192 deduction, not in the vendor ledger — and `Overtime` in particular is an
employment concept, not a professional fee.

### Exalture Software Lab appears on both sides

Exalture shows as an **inward credit** (₹1,04,400 in Feb) and as **outward debits** in
Jun–Sep. So they are both a customer and a vendor.

That needs **two separate ledger accounts** — a receivable and a payable — never a single
netted balance. If Adpedia ever settles net, the gross amounts must still be recorded on
both sides, because GST and TDS both apply to the gross, not the net.

### 🔴 What this means for TDS

Shinelal's exact drawings could not be established from the PDF (see above), so I am not
quoting an annualised figure. What is certain is that the **total leaving the account was
₹26,64,266 over eight months**, and that a director's remuneration forms a large part of it.

Once the Excel export is available the figure will be exact, and that is what the s.192
computation should be built on.

The mechanic that matters here: **TDS u/s 192 is deducted every month**, at roughly 1/12
of the estimated annual tax liability — not in a lump at year end. Six months into
FY 2026-27, if nothing has been deducted, there is a catch-up to make, and it carries
1%/month interest where TDS was deductible and not deducted, plus ₹200/day under s.234E
for late Form 24Q filings.

**Ask your CA to confirm the FY 2026-27 position before Q3 closes**, since the quarterly
24Q for Oct–Dec falls due 31 January.

### ⚠️ One document check

Your **GST certificate (REG-06, Annexure B)** lists the directors as:

> CHINNANGATH PRABHAKARAN SHEENA · PULIPARAMBIL SUBAIR ABINAS

**Shinelal is not among them.** Most likely he was appointed after the certificate was
issued on 11/11/2021 and the GST registration was never amended — a REG-14 amendment is
supposed to follow a change in directors or KMP.

Worth confirming, because the salary treatment rests on it:
1. Shinelal is on the **MCA record** as a director (verify on mca.gov.in)
2. A **board resolution** fixes the remuneration — a private company is outside the s.197
   managerial-remuneration limits, but still needs board authority under its articles
3. **GST registration amended** (REG-14) to reflect the current directors

Also confirm with the CA whether **Kerala profession tax** applies on the salary — it's a
small half-yearly levy to the local body, easily missed.

### System behaviour

Shinelal becomes an **employee record**, not a vendor:

```
Monthly payroll run
  Dr Director's Remuneration      2,38,000
  Cr TDS Payable (192)                   X     ← per CA's monthly computation
  Cr Salary Payable                2,38,000-X
        ↓
  Payment  Dr Salary Payable / Cr Bank        ← the line Part A reconciles
        ↓
  Challan by the 7th · Form 24Q quarterly · Form 16 by 15 June
```

He does **not** appear in the vendor ledger, carries **no GST**, and is excluded from
the 26Q deductee list.

---

## 8. Freelancers — ₹8.18 lakh, and the TDS that goes with it

| | Amount | 194J @10% | Above annual threshold? |
|---|---:|---:|---|
| Akash Raveendran | ₹4,45,141 | ₹44,514 | ✅ Comfortably |
| Deepak Damodaran | ₹2,24,571 | ₹22,457 | ✅ Comfortably |
| Nikhil M A | ₹1,30,012 | ₹13,001 | ✅ Comfortably |
| Praveen C D | ₹18,500 | ₹1,850 | ⚠️ Likely below — see below |
| **Total** | **₹8,18,224** | **₹81,822** | |

So roughly **₹82,000 of TDS** arises on these four for Feb–Sep 2026 alone, if 194J is the
right section. At 2% under 194C it would be ~₹16,400 — which is why the section matters.

**Three things to check with your CA, promptly:**

1. **Is this being deducted and deposited?** You hold TAN `CHNA09808A`, so the obligation
   exists. If it hasn't been, the cost of catching up is 1%/month interest where TDS was
   not deducted, 1.5%/month where deducted but not deposited, and ₹200/day under s.234E
   for late quarterly returns (capped at the TDS amount). It gets more expensive monthly,
   so it's worth resolving quickly rather than at year end.
2. **194J or 194C for each?** Design and development work delivered on the freelancer's own
   professional judgement is 194J at 10%. Work carried out to your written specification
   under a contract is 194C at 1% (individual/HUF). Most freelance dev/design work is 194J.
3. **PAN for all four.** Without PAN, s.206AA forces **20%** instead of 10%. Collect these
   before the next payment run.

**Praveen C D** at ₹18,500 sits below the annual 194J threshold, so no TDS may be due yet —
but the moment he crosses it, TDS falls due on the **entire cumulative amount**, not just
the excess. This is exactly the retrospective-threshold case the system must block on at
bill entry (`02-recon-tds-mobile-pdf.md` §B2).

---

## 9. What this changes in the build

The payee classification lands in three places:

- **Vendor master** — `default_tds_section`, `pan`, `pan_verified`, `is_director`
- **Payment entry** — proposes the section, computes TDS, warns on threshold crossing
- **Bank reconciliation** — the Part A rules table now resolves these five narrations
  automatically:

| Narration contains | Post to |
|---|---|
| `SHINELAL` | Director's account — treatment per §7 |
| `AKASH RAVEENDRAN` · `DEEPAK DAMODARAN` · `NIKHIL MA` · `Praveen C D` | Professional fees → vendor ledger, 194J |

That covers **128 of the 152 outward transactions (84%)** straight away, which makes the
reconciliation genuinely quick from day one.
