-- docs/46 · the electronic cash and credit ledgers, and the set-off that debits them

ALTER TYPE "SourceType" ADD VALUE 'GST_SET_OFF';

CREATE TABLE "GstSetOff" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "setOffOn" TIMESTAMP(3) NOT NULL,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rcm" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lateFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditIgstToIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditIgstToCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditIgstToSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditCgstToCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditCgstToIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditSgstToSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditSgstToIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashOther" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditUsed" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashUsed" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GstSetOff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GstSetOff_companyId_periodLabel_idx" ON "GstSetOff"("companyId", "periodLabel");

ALTER TABLE "GstSetOff" ADD CONSTRAINT "GstSetOff_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
