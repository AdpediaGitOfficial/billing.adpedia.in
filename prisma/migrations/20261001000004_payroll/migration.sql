-- s.192 TDS is 1/12 of an ESTIMATED ANNUAL liability, not a flat rate on each payment.
-- The estimate comes from the CA; this records it with an audit trail and allows revision.
CREATE TABLE "SalaryTaxEstimate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "estimatedAnnualTax" DECIMAL(18,2) NOT NULL,
    "source" TEXT,
    "note" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalaryTaxEstimate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SalaryTaxEstimate_companyId_employeeId_financialYearId_idx"
    ON "SalaryTaxEstimate"("companyId", "employeeId", "financialYearId");
ALTER TABLE "SalaryTaxEstimate" ADD CONSTRAINT "SalaryTaxEstimate_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Kerala profession tax: half-yearly, by salary slab, paid to the local body.
-- Effective-dated like every other rate in the system.
CREATE TABLE "ProfessionTaxSlab" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "fromAmount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2),
    "amount" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    CONSTRAINT "ProfessionTaxSlab_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProfessionTaxSlab_stateCode_effectiveFrom_idx"
    ON "ProfessionTaxSlab"("stateCode", "effectiveFrom");
