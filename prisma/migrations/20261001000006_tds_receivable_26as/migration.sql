-- Form 26AS is keyed by DEDUCTOR TAN, so the customer record has to carry one.
ALTER TABLE "Customer" ADD COLUMN "tan" TEXT;

-- Imported 26AS rows are kept, not matched-and-discarded: a row that matches nothing in
-- the books is itself a finding, usually unrecorded income.
CREATE TABLE "Form26asEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "deductorTan" TEXT NOT NULL,
    "deductorName" TEXT NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "amountPaid" DECIMAL(18,2) NOT NULL,
    "tdsDeducted" DECIMAL(18,2) NOT NULL,
    "dateOfDeduction" TIMESTAMP(3),
    "statusOfBooking" TEXT,
    "importBatch" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchedReceivableId" TEXT,
    CONSTRAINT "Form26asEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Form26asEntry_matchedReceivableId_key" ON "Form26asEntry"("matchedReceivableId");
CREATE INDEX "Form26asEntry_companyId_financialYearId_quarter_idx" ON "Form26asEntry"("companyId", "financialYearId", "quarter");
CREATE INDEX "Form26asEntry_companyId_deductorTan_idx" ON "Form26asEntry"("companyId", "deductorTan");

ALTER TABLE "Form26asEntry" ADD CONSTRAINT "Form26asEntry_matchedReceivableId_fkey"
    FOREIGN KEY ("matchedReceivableId") REFERENCES "TdsReceivable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
