-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "inrAmount" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "VendorBill" ADD COLUMN     "grandTotalInr" DECIMAL(18,2),
ADD COLUMN     "tdsAmountInr" DECIMAL(18,2);
