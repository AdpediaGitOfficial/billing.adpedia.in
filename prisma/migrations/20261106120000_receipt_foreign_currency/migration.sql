-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "inrAmount" DECIMAL(18,2);
