-- docs/50 · cancelling a payroll run or a TDS challan, and the filing record that decides it

ALTER TYPE "PayrollStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "PayrollRun"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT;

ALTER TABLE "TdsChallan"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT;

CREATE TABLE "TdsReturnFiling" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "formType" TEXT NOT NULL,
    "filedOn" TIMESTAMP(3) NOT NULL,
    "token" TEXT,
    "deducteeCount" INTEGER NOT NULL DEFAULT 0,
    "tdsDeducted" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsDeposited" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lateFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TdsReturnFiling_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TdsReturnFiling_companyId_financialYearId_quarter_formType_key"
  ON "TdsReturnFiling"("companyId", "financialYearId", "quarter", "formType");
CREATE INDEX "TdsReturnFiling_companyId_quarter_idx" ON "TdsReturnFiling"("companyId", "quarter");

ALTER TABLE "TdsReturnFiling" ADD CONSTRAINT "TdsReturnFiling_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
