/*
  Warnings:

  - You are about to drop the column `accountId` on the `BankRule` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "TdsDeduction_companyId_reversedAt_idx";

-- DropIndex
DROP INDEX "TdsDeduction_employeeId_idx";

-- DropIndex
DROP INDEX "TdsDeduction_vendorId_idx";

-- AlterTable
ALTER TABLE "BankRule" DROP COLUMN "accountId",
ADD COLUMN     "accountCode" TEXT;
