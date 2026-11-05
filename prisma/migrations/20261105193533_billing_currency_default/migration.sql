-- DropForeignKey
ALTER TABLE "TdsCertificate" DROP CONSTRAINT "TdsCertificate_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "TdsCertificate" DROP CONSTRAINT "TdsCertificate_vendorId_fkey";

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "billingCurrencyDefault" TEXT NOT NULL DEFAULT 'USD';

-- AddForeignKey
ALTER TABLE "TdsCertificate" ADD CONSTRAINT "TdsCertificate_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TdsCertificate" ADD CONSTRAINT "TdsCertificate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "TdsCertificate_unique_per_deductee" RENAME TO "TdsCertificate_companyId_financialYearId_formType_quarter_v_key";
