-- docs/65 · s.31(3)(e) — returning an advance, and recovering the GST paid on it

ALTER TYPE "DocType" ADD VALUE 'REFUND_VOUCHER';

CREATE TABLE "RefundVoucher" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bankAccountId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefundVoucher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefundVoucher_companyId_number_key" ON "RefundVoucher"("companyId", "number");
CREATE INDEX "RefundVoucher_companyId_receiptId_idx" ON "RefundVoucher"("companyId", "receiptId");

ALTER TABLE "RefundVoucher" ADD CONSTRAINT "RefundVoucher_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundVoucher" ADD CONSTRAINT "RefundVoucher_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
