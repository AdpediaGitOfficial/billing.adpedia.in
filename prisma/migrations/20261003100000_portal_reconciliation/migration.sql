-- docs/56 · what the portal said, as at a moment, and which challans it confirms

CREATE TYPE "PortalStatementKind" AS ENUM ('GST_CASH_LEDGER', 'GST_CREDIT_LEDGER', 'GST_CHALLANS', 'TDS_CHALLANS');

CREATE TABLE "PortalStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "PortalStatementKind" NOT NULL,
    "asOn" TIMESTAMP(3) NOT NULL,
    "filename" TEXT,
    "importBatch" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" TEXT,
    "verdict" TEXT,
    CONSTRAINT "PortalStatement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PortalStatementLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "head" TEXT,
    "balance" DECIMAL(18,2),
    "cin" TEXT,
    "bsrCode" TEXT,
    "challanSerial" TEXT,
    "depositedOn" TIMESTAMP(3),
    "amount" DECIMAL(18,2),
    "raw" TEXT NOT NULL,
    CONSTRAINT "PortalStatementLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortalStatement_companyId_kind_asOn_idx" ON "PortalStatement"("companyId", "kind", "asOn");
CREATE INDEX "PortalStatementLine_companyId_cin_idx" ON "PortalStatementLine"("companyId", "cin");
CREATE INDEX "PortalStatementLine_statementId_idx" ON "PortalStatementLine"("statementId");

ALTER TABLE "PortalStatementLine" ADD CONSTRAINT "PortalStatementLine_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "PortalStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- a CIN this system constructed is a guess until something outside it agrees
ALTER TABLE "TdsChallan" ADD COLUMN "portalConfirmedAt" TIMESTAMP(3);
ALTER TABLE "TdsChallan" ADD COLUMN "portalConfirmedVia" TEXT;
ALTER TABLE "GstChallan" ADD COLUMN "portalConfirmedAt" TIMESTAMP(3);
ALTER TABLE "GstChallan" ADD COLUMN "portalConfirmedVia" TEXT;
