-- docs/71 · the company's own advance tax: the CA's estimate, and the instalments paid

ALTER TYPE "SourceType" ADD VALUE 'ADVANCE_TAX';

CREATE TABLE "CompanyTaxEstimate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "estimatedAnnualTax" DECIMAL(18,2) NOT NULL,
    "source" TEXT,
    "note" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompanyTaxEstimate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompanyTaxEstimate_companyId_financialYearId_idx" ON "CompanyTaxEstimate"("companyId", "financialYearId");

CREATE TABLE "AdvanceTaxPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "bsrCode" TEXT NOT NULL,
    "challanSerial" TEXT NOT NULL,
    "cin" TEXT,
    "bankAccountId" TEXT,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdvanceTaxPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdvanceTaxPayment_companyId_bsrCode_challanSerial_paidOn_key"
  ON "AdvanceTaxPayment"("companyId", "bsrCode", "challanSerial", "paidOn");
CREATE INDEX "AdvanceTaxPayment_companyId_financialYearId_idx" ON "AdvanceTaxPayment"("companyId", "financialYearId");
