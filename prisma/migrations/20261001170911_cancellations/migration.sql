ALTER TABLE "Receipt" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Receipt" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "TdsReceivable" ADD COLUMN "reversedAt" TIMESTAMP(3);
ALTER TABLE "BillPayment" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "cancelReason" TEXT;
