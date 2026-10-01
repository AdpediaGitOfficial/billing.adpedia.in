-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Constitution" AS ENUM ('PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'LLP', 'PARTNERSHIP', 'PROPRIETORSHIP');

-- CreateEnum
CREATE TYPE "GstRegType" AS ENUM ('REGULAR', 'COMPOSITION', 'UNREGISTERED');

-- CreateEnum
CREATE TYPE "FyStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('TAX_INVOICE', 'EXPORT_INVOICE', 'PROFORMA', 'QUOTATION', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT', 'SELF_INVOICE', 'PAYMENT_ADVICE');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'VENDOR_BILL', 'BILL_PAYMENT', 'SELF_INVOICE', 'EXPENSE', 'PAYROLL', 'TDS_CHALLAN', 'GST_PAYMENT', 'BANK_TXN', 'MANUAL', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('B2B', 'B2C', 'SEZ', 'EXPORT');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('INTRA', 'INTER', 'EXPORT', 'SEZ_WITH_PAY', 'SEZ_WITHOUT_PAY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'SWIFT', 'OTHER');

-- CreateEnum
CREATE TYPE "VendorType" AS ENUM ('FREELANCER', 'SUBCONTRACTOR', 'AGENCY', 'SUPPLIER', 'UTILITY', 'CLOUD', 'PROFESSIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GstTreatment" AS ENUM ('STANDARD_18', 'STANDARD_12', 'STANDARD_5', 'EXEMPT', 'NONE', 'CHECK_SUPPLIER', 'MIXED');

-- CreateEnum
CREATE TYPE "ItcDefault" AS ENUM ('FULL', 'PARTIAL', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PaidFrom" AS ENUM ('BANK', 'CASH', 'CARD', 'PERSONAL_REIMBURSABLE');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('OLD', 'NEW');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "TdsBase" AS ENUM ('TAXABLE_VALUE', 'GROSS');

-- CreateEnum
CREATE TYPE "DeducteeType" AS ENUM ('EMPLOYEE', 'VENDOR', 'NON_RESIDENT');

-- CreateEnum
CREATE TYPE "TdsRecStatus" AS ENUM ('BOOKED', 'MATCHED_26AS', 'MISSING_IN_26AS', 'DISPUTED', 'CLAIMED');

-- CreateEnum
CREATE TYPE "GstReturnType" AS ENUM ('GSTR1', 'GSTR3B');

-- CreateEnum
CREATE TYPE "GstReturnStatus" AS ENUM ('OPEN', 'PREPARED', 'FILED');

-- CreateEnum
CREATE TYPE "StatementFormat" AS ENUM ('CSV', 'XLS', 'XLSX', 'PDF', 'API');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('UNMATCHED', 'SUGGESTED', 'PART_MATCHED', 'MATCHED', 'IGNORED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "RuleMatch" AS ENUM ('CONTAINS', 'REGEX', 'EXACT');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "constitution" "Constitution" NOT NULL DEFAULT 'PRIVATE_LIMITED',
    "cin" TEXT,
    "pan" TEXT NOT NULL,
    "tan" TEXT,
    "gstin" TEXT,
    "gstRegistrationType" "GstRegType" NOT NULL DEFAULT 'REGULAR',
    "gstRegisteredFrom" TIMESTAMP(3),
    "msmeUdyamNo" TEXT,
    "incorporatedOn" TIMESTAMP(3),
    "stateCode" TEXT NOT NULL,
    "registeredAddress" JSONB NOT NULL,
    "branchAddresses" JSONB,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "logoUrl" TEXT,
    "signatureImageUrl" TEXT,
    "stampImageUrl" TEXT,
    "brandPrimaryHex" TEXT DEFAULT '#4135AF',
    "brandFont" TEXT DEFAULT 'Poppins',
    "currencyDefault" TEXT NOT NULL DEFAULT 'INR',
    "fyStartMonth" INTEGER NOT NULL DEFAULT 4,
    "invoiceFooterText" TEXT,
    "defaultTerms" TEXT,
    "defaultPaymentDays" INTEGER NOT NULL DEFAULT 15,
    "showSacOnInvoice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyBankAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "ifsc" TEXT,
    "micr" TEXT,
    "swift" TEXT,
    "bankName" TEXT NOT NULL,
    "branch" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "upiId" TEXT,
    "ledgerAccountId" TEXT,
    "showOnInvoice" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CompanyBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyLut" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "arn" TEXT NOT NULL,
    "filedOn" TIMESTAMP(3),
    "fyLabel" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyLut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialYear" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "status" "FyStatus" NOT NULL DEFAULT 'OPEN',
    "lockedUpTo" TIMESTAMP(3),

    CONSTRAINT "FinancialYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSeries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "prefix" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCompany" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "UserCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "subType" TEXT,
    "parentId" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "entryNo" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "narration" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "sourceId" TEXT,
    "reversalOfId" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "narration" TEXT,
    "projectId" TEXT,
    "customerId" TEXT,
    "vendorId" TEXT,
    "employeeId" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "billingAddress" JSONB NOT NULL,
    "shippingAddress" JSONB,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "stateCode" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "customerType" "CustomerType" NOT NULL DEFAULT 'B2B',
    "paymentTermDays" INTEGER NOT NULL DEFAULT 15,
    "creditLimit" DECIMAL(18,2),
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "defaultTdsSection" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contractValue" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "startsOn" TIMESTAMP(3),
    "expectedEndOn" TIMESTAMP(3),
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "managerId" TEXT,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAllocation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "StaffAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sacCode" TEXT,
    "defaultRate" DECIMAL(18,2),
    "gstRatePct" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "incomeAccountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ServiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "projectId" TEXT,
    "docType" "DocType" NOT NULL DEFAULT 'TAX_INVOICE',
    "number" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "customerRef" TEXT,
    "milestone" TEXT,
    "taxMode" "TaxMode" NOT NULL,
    "placeOfSupply" TEXT NOT NULL,
    "lutId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "taxableValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsSection" TEXT,
    "tdsRatePct" DECIMAL(5,2),
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountReceived" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsCredited" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "irn" TEXT,
    "ackNo" TEXT,
    "ackDate" TIMESTAMP(3),
    "signedQr" TEXT,
    "pdfUrl" TEXT,
    "pdfSha256" TEXT,
    "templateVersion" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "serviceItemId" TEXT,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "detail" TEXT,
    "sacCode" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unit" TEXT DEFAULT 'Nos',
    "rate" DECIMAL(18,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "gstRatePct" DECIMAL(5,2) NOT NULL,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL,
    "pdfUrl" TEXT,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bankChargeAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "fxGainLoss" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "bankAccountId" TEXT,
    "isAdvance" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptAllocation" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ReceiptAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendorType" "VendorType" NOT NULL,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" JSONB,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "stateCode" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "panVerified" BOOLEAN NOT NULL DEFAULT false,
    "defaultTdsSection" TEXT,
    "lowerDeductionCertNo" TEXT,
    "lowerDeductionRate" DECIMAL(5,2),
    "lowerDeductionValidTo" TIMESTAMP(3),
    "lowerDeductionCap" DECIMAL(18,2),
    "isForeignSupplier" BOOLEAN NOT NULL DEFAULT false,
    "rcmApplicable" BOOLEAN NOT NULL DEFAULT false,
    "bankDetails" JSONB,
    "paymentTermDays" INTEGER NOT NULL DEFAULT 15,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "projectId" TEXT,
    "billNumber" TEXT NOT NULL,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL,
    "isRcm" BOOLEAN NOT NULL DEFAULT false,
    "rcmIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "selfInvoiceNo" TEXT,
    "selfInvoicePdfUrl" TEXT,
    "itcEligible" BOOLEAN NOT NULL DEFAULT true,
    "itcBlockedReason" TEXT,
    "tdsSection" TEXT,
    "tdsRatePct" DECIMAL(5,2),
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsChallanId" TEXT,
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "BillStatus" NOT NULL DEFAULT 'DRAFT',
    "attachmentUrl" TEXT,

    CONSTRAINT "VendorBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sacCode" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "rate" DECIMAL(18,2) NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "gstRatePct" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "expenseAccountId" TEXT,

    CONSTRAINT "VendorBillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "bankAccountId" TEXT,

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'STANDARD_18',
    "itcDefault" "ItcDefault" NOT NULL DEFAULT 'FULL',
    "tdsSection" TEXT,
    "rcmPossible" BOOLEAN NOT NULL DEFAULT false,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "projectId" TEXT,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL,
    "itcEligible" BOOLEAN NOT NULL DEFAULT true,
    "itcBlockedReason" TEXT,
    "isRcm" BOOLEAN NOT NULL DEFAULT false,
    "paidFrom" "PaidFrom" NOT NULL DEFAULT 'BANK',
    "receiptUrl" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'SUBMITTED',
    "approvedById" TEXT,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "vendorId" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "frequency" "Frequency" NOT NULL,
    "nextDueOn" TIMESTAMP(3) NOT NULL,
    "lastPostedOn" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "isDirector" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "phone" TEXT,
    "pan" TEXT,
    "joinedOn" TIMESTAMP(3) NOT NULL,
    "leftOn" TIMESTAMP(3),
    "bankDetails" JSONB,
    "taxRegime" "TaxRegime" NOT NULL DEFAULT 'NEW',

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStructure" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "components" JSONB NOT NULL,
    "grossMonthly" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "grossTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,
    "deductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "professionTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tds" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,2) NOT NULL,
    "components" JSONB NOT NULL,
    "pdfUrl" TEXT,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TdsSectionRate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "rateCompany" DECIMAL(5,2) NOT NULL,
    "rateIndividualHuf" DECIMAL(5,2) NOT NULL,
    "rateNoPan" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "thresholdSingle" DECIMAL(18,2),
    "thresholdAnnual" DECIMAL(18,2),
    "baseOn" "TdsBase" NOT NULL DEFAULT 'TAXABLE_VALUE',
    "returnForm" TEXT NOT NULL,

    CONSTRAINT "TdsSectionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GstRate" (
    "id" TEXT NOT NULL,
    "sacCode" TEXT,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "GstRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TdsDeduction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "deducteeType" "DeducteeType" NOT NULL,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "deducteePan" TEXT,
    "documentType" "SourceType" NOT NULL,
    "documentId" TEXT NOT NULL,
    "deductedOn" TIMESTAMP(3) NOT NULL,
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "tdsAmount" DECIMAL(18,2) NOT NULL,
    "challanId" TEXT,

    CONSTRAINT "TdsDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TdsChallan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "sectionCode" TEXT,
    "bsrCode" TEXT NOT NULL,
    "challanSerial" TEXT NOT NULL,
    "depositedOn" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "interest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lateFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cin" TEXT,

    CONSTRAINT "TdsChallan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TdsReceivable" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "invoiceId" TEXT,
    "customerId" TEXT NOT NULL,
    "deductorTan" TEXT,
    "sectionCode" TEXT NOT NULL,
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "tdsAmount" DECIMAL(18,2) NOT NULL,
    "bookedOn" TIMESTAMP(3) NOT NULL,
    "status" "TdsRecStatus" NOT NULL DEFAULT 'BOOKED',
    "form26asAmount" DECIMAL(18,2),
    "form16aReceived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TdsReceivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GstReturnPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "returnType" "GstReturnType" NOT NULL,
    "outputTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "inputTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rcmPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "filedOn" TIMESTAMP(3),
    "arn" TEXT,
    "status" "GstReturnStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "GstReturnPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT,
    "format" "StatementFormat" NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL,
    "closingBalance" DECIMAL(18,2) NOT NULL,
    "rowsImported" INTEGER NOT NULL DEFAULT 0,
    "rowsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "balanceCheckOk" BOOLEAN NOT NULL DEFAULT false,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "importId" TEXT,
    "txnDate" TIMESTAMP(3) NOT NULL,
    "valueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "direction" "Direction" NOT NULL,
    "rawNarration" TEXT NOT NULL,
    "refNo" TEXT,
    "utr" TEXT,
    "chequeNo" TEXT,
    "runningBalance" DECIMAL(18,2),
    "dedupeHash" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "confidence" DECIMAL(5,2),
    "matchReason" TEXT,
    "counterpartyGuess" TEXT,
    "receiptId" TEXT,
    "billPaymentId" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "matchType" "RuleMatch" NOT NULL DEFAULT 'CONTAINS',
    "pattern" TEXT NOT NULL,
    "direction" "Direction",
    "customerId" TEXT,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "accountId" TEXT,
    "confirmCount" INTEGER NOT NULL DEFAULT 0,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BankRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "format" "StatementFormat" NOT NULL,
    "headerRow" INTEGER NOT NULL DEFAULT 1,
    "columnMap" JSONB NOT NULL,
    "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    "amountStyle" TEXT NOT NULL DEFAULT 'SEPARATE_DR_CR',

    CONSTRAINT "BankProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_pan_gstin_key" ON "Company"("pan", "gstin");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyBankAccount_companyId_accountNo_key" ON "CompanyBankAccount"("companyId", "accountNo");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyLut_companyId_fyLabel_key" ON "CompanyLut"("companyId", "fyLabel");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialYear_companyId_label_key" ON "FinancialYear"("companyId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSeries_companyId_financialYearId_docType_key" ON "DocumentSeries"("companyId", "financialYearId", "docType");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_familyId_idx" ON "RefreshToken"("userId", "familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserCompany_userId_companyId_key" ON "UserCompany"("userId", "companyId");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_entity_entityId_idx" ON "AuditLog"("companyId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_at_idx" ON "AuditLog"("companyId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Account_companyId_code_key" ON "Account"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_date_idx" ON "JournalEntry"("companyId", "date");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceType_sourceId_idx" ON "JournalEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_financialYearId_entryNo_key" ON "JournalEntry"("companyId", "financialYearId", "entryNo");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_projectId_idx" ON "JournalLine"("projectId");

-- CreateIndex
CREATE INDEX "Customer_companyId_name_idx" ON "Customer"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_companyId_code_key" ON "Project"("companyId", "code");

-- CreateIndex
CREATE INDEX "StaffAllocation_employeeId_periodFrom_idx" ON "StaffAllocation"("employeeId", "periodFrom");

-- CreateIndex
CREATE INDEX "Invoice_companyId_status_dueDate_idx" ON "Invoice"("companyId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_companyId_number_key" ON "Invoice"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_companyId_number_key" ON "CreditNote"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_companyId_number_key" ON "Receipt"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptAllocation_receiptId_invoiceId_key" ON "ReceiptAllocation"("receiptId", "invoiceId");

-- CreateIndex
CREATE INDEX "Vendor_companyId_name_idx" ON "Vendor"("companyId", "name");

-- CreateIndex
CREATE INDEX "VendorBill_companyId_status_dueDate_idx" ON "VendorBill"("companyId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "VendorBill_companyId_vendorId_billNumber_key" ON "VendorBill"("companyId", "vendorId", "billNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_companyId_code_key" ON "ExpenseCategory"("companyId", "code");

-- CreateIndex
CREATE INDEX "Expense_companyId_date_idx" ON "Expense"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_companyId_employeeCode_key" ON "Employee"("companyId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_companyId_year_month_key" ON "PayrollRun"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_payrollRunId_employeeId_key" ON "Payslip"("payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TdsSectionRate_code_effectiveFrom_key" ON "TdsSectionRate"("code", "effectiveFrom");

-- CreateIndex
CREATE INDEX "TdsDeduction_companyId_financialYearId_quarter_sectionCode_idx" ON "TdsDeduction"("companyId", "financialYearId", "quarter", "sectionCode");

-- CreateIndex
CREATE UNIQUE INDEX "TdsChallan_companyId_bsrCode_challanSerial_depositedOn_key" ON "TdsChallan"("companyId", "bsrCode", "challanSerial", "depositedOn");

-- CreateIndex
CREATE INDEX "TdsReceivable_companyId_financialYearId_quarter_idx" ON "TdsReceivable"("companyId", "financialYearId", "quarter");

-- CreateIndex
CREATE UNIQUE INDEX "GstReturnPeriod_companyId_periodLabel_returnType_key" ON "GstReturnPeriod"("companyId", "periodLabel", "returnType");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_dedupeHash_key" ON "BankTransaction"("dedupeHash");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_receiptId_key" ON "BankTransaction"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_billPaymentId_key" ON "BankTransaction"("billPaymentId");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_bankAccountId_status_idx" ON "BankTransaction"("companyId", "bankAccountId", "status");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_txnDate_idx" ON "BankTransaction"("companyId", "txnDate");

-- CreateIndex
CREATE INDEX "BankRule_companyId_pattern_idx" ON "BankRule"("companyId", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "BankProfile_companyId_bankName_format_key" ON "BankProfile"("companyId", "bankName", "format");

-- AddForeignKey
ALTER TABLE "CompanyBankAccount" ADD CONSTRAINT "CompanyBankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyBankAccount" ADD CONSTRAINT "CompanyBankAccount_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyLut" ADD CONSTRAINT "CompanyLut_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialYear" ADD CONSTRAINT "FinancialYear_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_financialYearId_fkey" FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCompany" ADD CONSTRAINT "UserCompany_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCompany" ADD CONSTRAINT "UserCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_financialYearId_fkey" FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAllocation" ADD CONSTRAINT "StaffAllocation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAllocation" ADD CONSTRAINT "StaffAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_financialYearId_fkey" FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_lutId_fkey" FOREIGN KEY ("lutId") REFERENCES "CompanyLut"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_serviceItemId_fkey" FOREIGN KEY ("serviceItemId") REFERENCES "ServiceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_tdsChallanId_fkey" FOREIGN KEY ("tdsChallanId") REFERENCES "TdsChallan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "VendorBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "VendorBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TdsDeduction" ADD CONSTRAINT "TdsDeduction_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "TdsChallan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TdsReceivable" ADD CONSTRAINT "TdsReceivable_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_billPaymentId_fkey" FOREIGN KEY ("billPaymentId") REFERENCES "BillPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

