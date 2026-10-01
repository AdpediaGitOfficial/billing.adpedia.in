# 12 · Accounting & Tax Engine

The part that must be right. Everything else is a form over this.

---

## 1. Chart of accounts — seed

Codes follow a standard 4-digit scheme. `isSystem: true` rows cannot be deleted or
renamed by users, because posting rules reference them by code.

```
ASSETS
  1000  Bank Accounts
    1010  Axis Bank — Current 921020015185413      [BANK]
  1050  Cash in Hand                                [CASH]
  1100  Accounts Receivable                         [AR]      ← control account
  1200  Input GST
    1210  Input CGST                                [GST_INPUT]
    1220  Input SGST                                [GST_INPUT]
    1230  Input IGST                                [GST_INPUT]
    1240  Input IGST — RCM                          [GST_INPUT]
  1250  Electronic Cash Ledger                                ← docs/46
    1251  Cash Ledger — IGST                        [GST_CASH]
    1252  Cash Ledger — CGST                        [GST_CASH]
    1253  Cash Ledger — SGST                        [GST_CASH]
    1254  Cash Ledger — interest, fee & penalty     [GST_CASH]
  1300  TDS Receivable                              [TDS_REC]
    1310  TDS Receivable — 194J
    1320  TDS Receivable — 194C
  1400  Advances to Vendors
  1500  Fixed Assets

LIABILITIES
  2000  Accounts Payable                            [AP]      ← control account
  2100  Output GST
    2110  Output CGST                               [GST_OUTPUT]
    2120  Output SGST                               [GST_OUTPUT]
    2130  Output IGST                               [GST_OUTPUT]
    2140  IGST Payable — RCM                        [GST_RCM]
  2200  TDS Payable
    2210  TDS Payable — 192  (salary)
    2220  TDS Payable — 194J
    2230  TDS Payable — 194C
    2240  TDS Payable — 195  (non-resident)
  2300  Salary Payable
  2310  Profession Tax Payable
  2400  Advances from Customers
  2500  Director's Current Account                  ← if any drawings are NOT remuneration

EQUITY
  3000  Share Capital
  3100  Retained Earnings
  3200  Current Year Profit                         ← system, closing entry target

INCOME
  4000  Revenue
    4010  Software Development
    4020  Staff Augmentation
    4030  Design Services
    4040  Film & Video Production
  4900  Other Income
    4910  Interest Income
    4920  Forex Gain

EXPENSES
  5100  Salary & Wages
    5110  Director's Remuneration                   ← Shinelal
    5120  Staff Salaries                            ← Akash, Deepak, Kiran
  5200  Professional & Contract
    5210  Freelancer Fees — 194J                    ← the 9
    5220  Subcontract — 194C                        ← Exalture
  5300  Infrastructure
    5310  Cloud & Hosting                           ← AWS, DigitalOcean
    5320  Internet & Telephone                      ← Blue Light Cable Vision
    5330  Domains & Software Subscriptions          ← GoDaddy, Figma
  5400  Travel & Conveyance
  5500  Office & Admin
  5600  Bank Charges
  5700  Marketing
  5900  Forex Loss
```

⚠️ **4010 vs 4020 vs 4040** — Adpedia's CIN class is film/entertainment but the invoices
say staff augmentation and web development. Keep all four; the invoice line's
`ServiceItem.incomeAccountId` picks one. Revenue by service becomes a report for free.

---

## 2. Posting rules

Every rule is a pure function: `(document, config) → JournalEntry`. No I/O, no Prisma.
That is what makes them property-testable.

```ts
type Posting = { accountCode: string; debit?: Dec; credit?: Dec
                 projectId?: string; customerId?: string; vendorId?: string; employeeId?: string }
type Rule<T> = (doc: T, cfg: PostingConfig) => Posting[]
```

The journal builder asserts `Σ debit === Σ credit` before writing, and the database
trigger asserts it again at commit. Two independent checks, deliberately.

### 2.1 Invoice raised — intra-state

`ADP/26-27/0026` · ₹85,000 + CGST 9% + SGST 9%

| Account | Debit | Credit |
|---|---:|---:|
| 1100 Accounts Receivable | 1,00,300.00 | |
| 4020 Staff Augmentation | | 70,000.00 |
| 4030 Design Services | | 15,000.00 |
| 2110 Output CGST | | 7,650.00 |
| 2120 Output SGST | | 7,650.00 |

Dimensions: `customerId`, `projectId` on every line.
**No TDS entry here.** TDS is recognised on receipt, not on raising — the customer may
not deduct at all.

### 2.2 Invoice raised — inter-state

Same, with `2130 Output IGST 15,300.00` replacing the CGST/SGST pair.

### 2.3 Invoice raised — export, zero-rated under LUT

| Account | Debit | Credit |
|---|---:|---:|
| 1100 Accounts Receivable | 4,200.00 USD @ fxRate | |
| 4010 Software Development | | (same, in INR) |

No GST lines at all. `Invoice.lutId` must be set — see §4.3.

### 2.4 Receipt with TDS deducted by the customer

Customer pays ₹91,800 against the ₹1,00,300 invoice, deducting 194J @10% on ₹85,000.

| Account | Debit | Credit |
|---|---:|---:|
| 1010 Axis Bank | 91,800.00 | |
| 1310 TDS Receivable — 194J | 8,500.00 | |
| 1100 Accounts Receivable | | 1,00,300.00 |

Also creates a `TdsReceivable` row tagged `{ fy, quarter, customerId, deductorTan,
section }` — that is what reconciles to Form 26AS later.

### 2.5 Vendor bill — domestic, with TDS

Exalture, ₹2,00,000 + 18% GST, TDS 194C @2%.

**Bill:**

| Account | Debit | Credit |
|---|---:|---:|
| 5220 Subcontract — 194C | 2,00,000.00 | |
| 1210 Input CGST | 18,000.00 | |
| 1220 Input SGST | 18,000.00 | |
| 2000 Accounts Payable | | 2,36,000.00 |

**TDS deduction** (separate entry, same transaction):

| Account | Debit | Credit |
|---|---:|---:|
| 2000 Accounts Payable | 4,000.00 | |
| 2230 TDS Payable — 194C | | 4,000.00 |

**Payment:** `Dr 2000 AP 2,32,000 / Cr 1010 Bank 2,32,000` ← the line reconciliation matches.

TDS base is **₹2,00,000, not ₹2,36,000** — taxable value excluding GST, per Circular 23/2017.

### 2.6 Vendor bill — foreign supplier, reverse charge

DigitalOcean, USD 300 ≈ ₹25,000, no GST on the invoice.

**Bill:**

| Account | Debit | Credit |
|---|---:|---:|
| 5310 Cloud & Hosting | 25,000.00 | |
| 2000 Accounts Payable | | 25,000.00 |

**RCM self-invoice** (s.31(3)(f)):

| Account | Debit | Credit |
|---|---:|---:|
| 1240 Input IGST — RCM | 4,500.00 | |
| 2140 IGST Payable — RCM | | 4,500.00 |

**RCM paid in cash:** deposited under the IGST major head, then debited at the set-off —
`Dr 1251 / Cr 1010 Bank 4,500`, then `Dr 2140 / Cr 1251 4,500` (docs/46). 🔴 Never set off
against existing ITC: tax under reverse charge is not "output tax" (s.2(82)), so s.49(4) does
not let credit discharge it.

Net cost to the business: ₹25,000. The ₹4,500 goes out and comes back as ITC in the same
GSTR-3B.

### 2.7 Payroll — monthly run

4 employees, gross ₹4,50,000, s.192 TDS ₹95,000, profession tax ₹1,000.

| Account | Debit | Credit |
|---|---:|---:|
| 5110 Director's Remuneration | 2,38,000.00 | |
| 5120 Staff Salaries | 2,12,000.00 | |
| 2210 TDS Payable — 192 | | 95,000.00 |
| 2310 Profession Tax Payable | | 1,000.00 |
| 2300 Salary Payable | | 3,54,000.00 |

**Payment:** `Dr 2300 / Cr 1010 Bank`.

**Then project allocation** — a second, *non-cash* entry driven by `StaffAllocation`.
It reclassifies salary into project cost so project margin is real:

```
Akash ₹80,000 · Prime 60% / Nuvé 30% / Internal 10%
  → JournalLine(5120, debit 0, credit 0) with projectId dimensions
```

⚠️ **Design decision:** do **not** move money between accounts for allocation. Keep salary
in 5120 for the P&L and carry `projectId` on the journal lines as a *dimension*. Project
cost is then a query (`SUM by projectId`), not a second set of accounts. Allocating into
separate project accounts would double the chart of accounts and break the trial balance
against statutory heads.

### 2.8 Bank charges (from reconciliation)

`Dr 5600 Bank Charges 100 / Dr 1210+1220 Input GST 18 / Cr 1010 Bank 118`

Auto-posted by the `Monthly Service Chrgs` bank rule.

### 2.9 TDS challan deposited

`Dr 2210/2220/2230/2240 (per section) / Cr 1010 Bank`
Plus `interest` → `5500`, `lateFee` → `5500` if any. Links every `TdsDeduction` it covers.

### 2.10 Reversal

Never edit a posted entry. Create a mirror with debits and credits swapped,
`reversalOfId` set, dated in an **open** period.

---

## 3. GST engine

### 3.1 Mode derivation — never typed by a user

```ts
export function resolveTaxMode(company: Company, customer: Customer): TaxMode {
  if (customer.country !== 'IN')            return 'EXPORT'
  if (customer.customerType === 'SEZ')      return company.sezWithPayment ? 'SEZ_WITH_PAY' : 'SEZ_WITHOUT_PAY'
  if (customer.stateCode === company.stateCode) return 'INTRA'
  return 'INTER'
}
```

For Adpedia (`stateCode: '32'`): Kerala customer → `INTRA` (CGST+SGST), any other Indian
state → `INTER` (IGST), overseas → `EXPORT` (zero-rated).

**Place of supply** defaults from the mode but is overridable per invoice — services have
special rules (s.12/13 IGST Act) and the accountant occasionally needs to override.
An override must be recorded with a reason in the audit log.

### 3.2 Computation and rounding

🔴 **Round per line, then sum. Never sum then round.**

```ts
const round2 = (d: Dec) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)

for (const line of lines) {
  line.taxableValue = round2(line.rate.mul(line.quantity).mul(new Dec(1).minus(line.discountPct.div(100))))
  const tax = round2(line.taxableValue.mul(line.gstRatePct).div(100))
  if (mode === 'INTRA') { line.cgst = round2(tax.div(2)); line.sgst = tax.minus(line.cgst) }
  else if (mode === 'INTER') { line.igst = tax }
  // EXPORT / SEZ_WITHOUT_PAY: all zero
}

invoice.taxableValue = sum(lines, 'taxableValue')
invoice.cgst = sum(lines, 'cgst');  invoice.sgst = sum(lines, 'sgst');  invoice.igst = sum(lines, 'igst')

const raw      = invoice.taxableValue.plus(invoice.cgst).plus(invoice.sgst).plus(invoice.igst)
invoice.grandTotal = raw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)   // round to the rupee
invoice.roundOff   = invoice.grandTotal.minus(raw)                    // stored, never implicit
```

`line.sgst = tax.minus(line.cgst)` rather than a second division — that is what stops a
half-paisa appearing when the tax is odd.

### 3.3 Input tax credit

`itcEligible` is set by `ExpenseCategory.itcDefault` and overridden only with a recorded
reason. Blocked under **s.17(5)**:

| Blocked | Reason code |
|---|---|
| Food, beverages, restaurant, outdoor catering | `S17_5_B_FOOD` |
| Cab / passenger transport | `S17_5_B_CAB` |
| Hotel GST charged in a state where Adpedia has no registration | `NO_REGISTRATION_IN_STATE` |
| Personal consumption | `S17_5_G_PERSONAL` |

### 3.4 Returns

**GSTR-1** (outward) and **GSTR-3B** (summary) are built as **exports for the CA**, not
filed by the system. Same reasoning as the TDS returns — the portal schema changes.

GSTR-1 export needs: B2B invoices by GSTIN, B2C consolidated, exports table, credit notes,
**HSN/SAC summary**. That last one is why `showSacOnInvoice: false` is only a *print*
setting — the SAC is still captured on every line, just not printed. See
`04-expense-categories.md` §7.2.

⚠️ **QRMP** — at ~₹39L turnover Adpedia is likely on quarterly filing with monthly tax
payment. `GstReturnPeriod.periodLabel` supports both `2026-10` and `2026-Q3`. Confirm which.

---

## 4. TDS engine

### 4.1 Rate resolution

```ts
export async function resolveTdsRate(input: {
  sectionCode: string; onDate: Date
  deductee: { pan?: string; panVerified: boolean; isCompanyOrFirm: boolean
              lowerDeductionRate?: Dec; lowerDeductionValidTo?: Date; lowerDeductionCap?: Dec }
  cumulativePaidThisFy: Dec; thisPaymentBase: Dec
}): Promise<{ ratePct: Dec; applyOn: Dec; reason: string }> {

  const rate = await rateAsOf(input.sectionCode, input.onDate)   // effective-dated row

  // 1. no PAN → s.206AA
  if (!input.deductee.pan || !input.deductee.panVerified)
    return { ratePct: rate.rateNoPan, applyOn: input.thisPaymentBase, reason: 'No verified PAN — s.206AA' }

  // 2. s.197 lower-deduction certificate, still valid and under its cap
  if (input.deductee.lowerDeductionRate && input.deductee.lowerDeductionValidTo! >= input.onDate
      && input.cumulativePaidThisFy.lt(input.deductee.lowerDeductionCap ?? Infinity))
    return { ratePct: input.deductee.lowerDeductionRate, applyOn: input.thisPaymentBase,
             reason: 'Lower deduction certificate u/s 197' }

  const pct = input.deductee.isCompanyOrFirm ? rate.rateCompany : rate.rateIndividualHuf
  const cumulativeAfter = input.cumulativePaidThisFy.plus(input.thisPaymentBase)

  // 3. still under both thresholds → no deduction
  const underSingle = !rate.thresholdSingle || input.thisPaymentBase.lte(rate.thresholdSingle)
  const underAnnual = !rate.thresholdAnnual || cumulativeAfter.lte(rate.thresholdAnnual)
  if (underSingle && underAnnual)
    return { ratePct: new Dec(0), applyOn: new Dec(0), reason: 'Below threshold' }

  // 4. 🔴 threshold crossed this bill → deduct on the WHOLE cumulative amount
  const justCrossed = rate.thresholdAnnual
    && input.cumulativePaidThisFy.lte(rate.thresholdAnnual)
    && cumulativeAfter.gt(rate.thresholdAnnual)
  if (justCrossed)
    return { ratePct: pct, applyOn: cumulativeAfter,
             reason: `Annual threshold crossed — deducting on full ₹${cumulativeAfter} to date` }

  return { ratePct: pct, applyOn: input.thisPaymentBase, reason: 'Normal rate' }
}
```

Step 4 is the one everybody gets wrong. Praveen C D is the live case — below threshold
now, and the moment he crosses it TDS falls due on everything paid to date, not the excess.
**The bill form must show this as a blocking prompt**, not a report in March.

### 4.2 Base amount

```ts
const base = section.baseOn === 'TAXABLE_VALUE' ? bill.taxableValue : bill.grandTotal
```

Default `TAXABLE_VALUE` — TDS on the amount excluding GST where GST is shown separately,
per **CBDT Circular 23/2017**.

### 4.3 Sections in use at Adpedia

| Section | Who | Rate | Return |
|---|---|---|---|
| **192** | Shinelal (director), Akash, Deepak, Kiran | slab, monthly | **24Q** |
| **194J** | the 9 freelancers | 10% | **26Q** |
| **194C** | Exalture (company → 2%) | 1% / 2% | **26Q** |
| **195** | Afrizon Crenergy Trade Pte (Singapore) | DTAA | **27Q** |

**s.192 is different from the rest.** It is not a flat rate on each payment — it is
1/12 of the *estimated annual liability*, recomputed each month as the picture changes.
The payroll module owns it:

```ts
monthlyTds = (estimatedAnnualTax − taxAlreadyDeductedThisFy) / monthsRemainingInFy
```

⚠️ Requires the employee's declared regime, investment declarations and other income.
Keep it as an **input the CA supplies per employee per year**, with the system prorating —
do not attempt to implement the Income Tax Act's slab logic.

**s.195 additionally requires**, before remittance: a Tax Residency Certificate and
Form 10F from the payee for the treaty rate, and **Form 15CA/15CB**. Model as a checklist
that blocks payment until ticked.

### 4.4 TDS receivable — 26AS reconciliation

Match `TdsReceivable` rows to an imported 26AS on `(deductorTan, sectionCode, quarter,
amount ±₹1)`. Outcomes: `MATCHED_26AS`, `MISSING_IN_26AS` (→ task: chase Form 16A),
or present in 26AS but not in books (→ possible unrecorded income, investigate).

### 4.5 Returns and challans

- Deposit by the **7th** of the following month; March by **30 April**
- 24Q/26Q/27Q quarterly: 31 Jul, 31 Oct, 31 Jan, 31 May
- Export a **validated deductee-wise CSV** for the CA's RPU — do not write FVU files
- Pre-flight validator: missing PAN, invalid PAN format, unlinked challan,
  `challan.amount ≠ Σ deductions`
- Interest: **1%/month** deductible-not-deducted, **1.5%/month** deducted-not-deposited,
  **₹200/day** s.234E late return, capped at the TDS amount

---

## 5. Period lock

```ts
async function assertPostable(companyId: string, date: Date) {
  const fy = await resolveFy(companyId, date)
  if (fy.status === 'CLOSED')  throw new PeriodLocked(`FY ${fy.label} is closed`)
  if (fy.lockedUpTo && date <= fy.lockedUpTo)
    throw new PeriodLocked(`Period locked to ${fmt(fy.lockedUpTo)} — post a reversal in an open period instead`)
}
```

Called by **every** posting path. A GST return marked `FILED` advances `lockedUpTo` to
that period's end automatically.

---

## 6. What must be property-tested

```ts
test.prop([arbitraryInvoice()])('every invoice posting balances', (inv) => {
  const lines = postInvoice(inv, cfg)
  expect(sum(lines, 'debit')).toEqual(sum(lines, 'credit'))
})
```

Run the same property over every rule in §2. Then the specific cases in
`10-spec-overview.md` §7 — concurrency on numbering, the LUT guard, threshold crossing,
RCM netting to zero, and a replay of the real Axis statement.
