-- docs/62 · GSTR-2B, invoice by invoice

ALTER TYPE "PortalStatementKind" ADD VALUE 'GST_2B';

CREATE TABLE "Gst2bLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierGstin" TEXT NOT NULL,
    "supplierName" TEXT,
    "docNumber" TEXT NOT NULL,
    "docKey" TEXT NOT NULL,
    "docDate" TIMESTAMP(3),
    "docType" TEXT,
    "taxableValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "itcAvailable" BOOLEAN NOT NULL DEFAULT true,
    "itcReason" TEXT,
    "matchedBillId" TEXT,
    "raw" TEXT NOT NULL,
    CONSTRAINT "Gst2bLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Gst2bLine_companyId_supplierGstin_docKey_idx" ON "Gst2bLine"("companyId", "supplierGstin", "docKey");
CREATE INDEX "Gst2bLine_statementId_idx" ON "Gst2bLine"("statementId");

ALTER TABLE "Gst2bLine" ADD CONSTRAINT "Gst2bLine_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "PortalStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
