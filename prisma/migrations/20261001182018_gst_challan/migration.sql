CREATE TABLE "GstChallan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "cpin" TEXT,
    "cin" TEXT,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rcm" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lateFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL,
    "bankAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GstChallan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GstChallan_companyId_periodLabel_idx" ON "GstChallan"("companyId", "periodLabel");

ALTER TABLE "GstChallan" ADD CONSTRAINT "GstChallan_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
