-- A cancelled bill must not delete its TDS deduction: the no-hard-delete trigger
-- refuses it, and correctly so. Mark it reversed instead and exclude it from
-- challans and the quarterly return.
ALTER TABLE "TdsDeduction" ADD COLUMN "reversedAt" TIMESTAMP(3);
CREATE INDEX "TdsDeduction_companyId_reversedAt_idx" ON "TdsDeduction"("companyId", "reversedAt");
