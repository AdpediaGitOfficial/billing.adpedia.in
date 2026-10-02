-- docs/52 · amending what has already been filed

ALTER TYPE "SourceType" ADD VALUE 'GST_AMENDMENT';

CREATE TABLE "GstAmendment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "originalPeriod" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "revisedGstin" TEXT,
    "revisedPlaceOfSupply" TEXT NOT NULL,
    "revisedTaxMode" "TaxMode" NOT NULL,
    "revisedTaxableValue" DECIMAL(18,2) NOT NULL,
    "revisedCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revisedSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revisedIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revisedGrandTotal" DECIMAL(18,2) NOT NULL,
    "originalTaxableValue" DECIMAL(18,2) NOT NULL,
    "originalCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "originalSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "originalIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GstAmendment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GstAmendment_companyId_periodLabel_idx" ON "GstAmendment"("companyId", "periodLabel");
CREATE INDEX "GstAmendment_companyId_invoiceId_idx" ON "GstAmendment"("companyId", "invoiceId");

ALTER TABLE "GstAmendment" ADD CONSTRAINT "GstAmendment_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GstAmendment" ADD CONSTRAINT "GstAmendment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TdsCorrection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "filingId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "filedOn" TIMESTAMP(3) NOT NULL,
    "token" TEXT,
    "reason" TEXT NOT NULL,
    "tdsDeducted" DECIMAL(18,2) NOT NULL,
    "tdsDeposited" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TdsCorrection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TdsCorrection_companyId_filingId_idx" ON "TdsCorrection"("companyId", "filingId");

ALTER TABLE "TdsCorrection" ADD CONSTRAINT "TdsCorrection_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TdsCorrection" ADD CONSTRAINT "TdsCorrection_filingId_fkey"
  FOREIGN KEY ("filingId") REFERENCES "TdsReturnFiling"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
