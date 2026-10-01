# 11 · Data Model

**The schema itself is [`prisma/schema.prisma`](../prisma/schema.prisma)** — 42 models,
30 enums, 1,176 lines, validated with `prisma validate` and formatted with `prisma format`.
This document explains the decisions in it rather than repeating it.

```bash
DATABASE_URL="postgresql://…" npx prisma validate
DATABASE_URL="postgresql://…" npx prisma migrate dev --name init
```

---

## 1. Model groups

| Group | Models |
|---|---|
| **Organisation** | `Company` `CompanyBankAccount` `CompanyLut` `FinancialYear` `DocumentSeries` |
| **Security** | `User` `RefreshToken` `UserCompany` `AuditLog` |
| **Ledger** | `Account` `JournalEntry` `JournalLine` |
| **Sales** | `Customer` `Project` `StaffAllocation` `ServiceItem` `Invoice` `InvoiceLine` `CreditNote` `Receipt` `ReceiptAllocation` |
| **Purchases** | `Vendor` `VendorBill` `VendorBillLine` `BillPayment` |
| **Expenses** | `ExpenseCategory` `Expense` `RecurringExpense` |
| **Payroll** | `Employee` `SalaryStructure` `PayrollRun` `Payslip` |
| **Tax config** | `TdsSectionRate` `GstRate` |
| **Tax transactions** | `TdsDeduction` `TdsChallan` `TdsReceivable` `GstReturnPeriod` |
| **Banking** | `BankStatementImport` `BankTransaction` `BankRule` `BankProfile` |

---

## 2. Decisions worth knowing

### 2.1 `JournalLine` carries dimensions, not separate accounts

`projectId` · `customerId` · `vendorId` · `employeeId` sit on the line. Project P&L is a
`GROUP BY projectId` over journal lines, not a parallel chart of accounts.

The alternative — an account per project — doubles the chart, breaks the trial balance
against statutory heads, and makes the balance sheet unreadable. Dimensions keep the
statutory view clean and the management view a query away.

### 2.2 `CompanyLut` is a collection, not a field

LUTs are annual and expire silently. Modelling it as `Company.lutArn` guarantees the
FY 2024-25 value is still sitting there in FY 2026-27 — which is exactly the situation we
found. `Invoice.lutId` is a real FK, so an export invoice **cannot** be posted pointing at
a LUT that doesn't cover its financial year.

### 2.3 `DocumentSeries.nextSeq` is the only source of invoice numbers

Allocated inside the creating transaction:

```ts
const s = await tx.$queryRaw`
  SELECT * FROM "DocumentSeries"
  WHERE "companyId" = ${companyId} AND "financialYearId" = ${fyId} AND "docType" = 'TAX_INVOICE'
  FOR UPDATE`
const number = render(s.pattern, { FY: fy.label, SEQ: s.nextSeq })
await tx.documentSeries.update({ where: { id: s.id }, data: { nextSeq: s.nextSeq + 1 } })
```

Seeded to **26** for FY 2026-27. `@@unique([companyId, number])` on `Invoice` is the
backstop. This is what makes the duplicate-invoice-11 incident structurally impossible.

### 2.4 Rates are effective-dated rows

`TdsSectionRate` and `GstRate` carry `effectiveFrom` / `effectiveTo`. Resolution is always
`rateAsOf(code, documentDate)` — never a constant, never "current". A February rate change
is a seed row, and **historic documents keep reproducing their original tax**.

### 2.5 `BankTransaction.dedupeHash` is unique at the database level

```
sha256(bankAccountId | valueDate | amount | direction | normalise(narration) | refNo)
```

People re-upload overlapping date ranges constantly. A unique index makes double-import
impossible rather than merely unlikely.

### 2.6 Nullable `stateCode` on `Customer` is deliberate

Null means overseas. `resolveTaxMode` keys off `country !== 'IN'` first, so a null state
can never accidentally compare equal to Adpedia's `'32'` and produce an intra-state invoice
for a Dubai client.

### 2.7 Money and currency

Every monetary column is `@db.Decimal(18,2)`. Documents that can be foreign-currency
(`Invoice`, `VendorBill`) carry `currency` + `fxRate`; **the ledger is always INR**.
`JournalLine` has no currency column by design — a general ledger in mixed currencies
cannot produce a trial balance.

### 2.8 `Vendor.isForeignSupplier` drives RCM

Set once per vendor from whether their invoice shows a GSTIN. Drives `rcmApplicable`,
which drives self-invoice generation and the `2140 / 1240` RCM posting pair. Live for
DigitalOcean and Afrizon Crenergy Trade Pte.

### 2.9 Soft delete only on drafts

No `deletedAt` on `Invoice`, `JournalEntry`, `Receipt`, `VendorBill`, `TdsDeduction`.
Cancellation is a status plus a reversal entry. `@@unique([companyId, number])` persists
through cancellation so the series stays explainable.

---

## 3. Seed data

`prisma/seed/` runs in this order:

| File | Contents |
|---|---|
| `01-company.ts` | Adpedia — PAN `AAUCA9985H`, GSTIN `32AAUCA9985H1ZX`, CIN, TAN `CHNA09808A`, VIII/318 address, state `32` |
| `02-financial-years.ts` | FY 2025-26 (CLOSED), FY 2026-27 (OPEN) |
| `03-series.ts` | `ADP/{FY}/{SEQ:4}`, `nextSeq: 26` |
| `04-accounts.ts` | Chart of accounts — `12-accounting-and-tax-engine.md` §1 |
| `05-bank.ts` | Axis `921020015185413`, IFSC `UTIB0002174`, mapped to account `1010` |
| `06-luts.ts` | `AD320324005917B` (FY 2024-25), `AD320325043063O` (FY 2025-26) |
| `07-tds-rates.ts` | 192, 194J, 194C, 195 — ⚠️ rates and thresholds **to be confirmed by the CA** |
| `08-expense-categories.ts` | `04-expense-categories.md` §5 |
| `09-employees.ts` | Shinelal (director), Akash, Deepak, Kiran |
| `10-vendors.ts` | 9 freelancers (194J), Exalture (194C), Blue Light, DigitalOcean + Afrizon (foreign, RCM) |
| `11-customers.ts` | Click AR, and the export client |
| `12-legacy-invoices.ts` | Invoices 1–25 imported as `status: CANCELLED`-equivalent reserved rows, so numbers can never be reissued |

🔴 **`07-tds-rates.ts` ships with placeholder rates and a loud comment.** Every rate and
threshold must be confirmed before the first live deduction.

---

## 4. Indexes that matter

Already in the schema; listed because they are the ones under real query load:

| Index | Serves |
|---|---|
| `Invoice(companyId, status, dueDate)` | AR ageing, overdue tile, reminders |
| `VendorBill(companyId, status, dueDate)` | AP ageing, payment run |
| `JournalLine(projectId)` | project P&L |
| `JournalLine(accountId)` | trial balance, ledger statements |
| `JournalEntry(companyId, date)` | P&L and balance sheet by period |
| `JournalEntry(sourceType, sourceId)` | "show me the entry behind this invoice" |
| `BankTransaction(companyId, bankAccountId, status)` | the reconciliation queue |
| `TdsDeduction(companyId, financialYearId, quarter, sectionCode)` | 24Q/26Q/27Q builds |
| `TdsReceivable(companyId, financialYearId, quarter)` | 26AS reconciliation |
| `AuditLog(companyId, entity, entityId)` | document history |

---

## 5. What is deliberately absent

| Not modelled | Why |
|---|---|
| Multi-currency ledger | Books are INR. Foreign amounts convert at document level. |
| Inventory / stock | Services business. |
| E-invoice IRP client | Fields exist (`irn`, `ackNo`, `signedQr`); no integration until ₹5 Cr. |
| Fixed-asset depreciation schedule | Account `1500` exists; the CA computes depreciation annually. |
| Budgets / forecasting | Phase 10+. |
| Document workflow engine | Statuses are enums; approvals are a `approvedById` field, not a state machine. |
