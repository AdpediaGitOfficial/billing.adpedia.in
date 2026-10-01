-- Idempotency key for the offline expense queue.
ALTER TABLE "Expense" ADD COLUMN "clientKey" TEXT;

CREATE UNIQUE INDEX "Expense_companyId_clientKey_key" ON "Expense"("companyId", "clientKey");
