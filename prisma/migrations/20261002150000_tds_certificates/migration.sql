-- docs/55 · the register of certificates downloaded from TRACES and issued

ALTER TYPE "AttachmentKind" ADD VALUE 'TDS_CERTIFICATE';

CREATE TABLE "TdsCertificate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "formType" TEXT NOT NULL,
    "quarter" INTEGER,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "pan" TEXT,
    "tdsAmount" DECIMAL(18,2) NOT NULL,
    "tracesRequestNo" TEXT,
    "downloadedOn" TIMESTAMP(3),
    "issuedOn" TIMESTAMP(3),
    "issuedTo" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TdsCertificate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TdsCertificate_unique_per_deductee"
  ON "TdsCertificate"("companyId", "financialYearId", "formType", "quarter", "vendorId", "employeeId");
CREATE INDEX "TdsCertificate_companyId_financialYearId_quarter_idx"
  ON "TdsCertificate"("companyId", "financialYearId", "quarter");

ALTER TABLE "TdsCertificate" ADD CONSTRAINT "TdsCertificate_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TdsCertificate" ADD CONSTRAINT "TdsCertificate_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TdsCertificate" ADD CONSTRAINT "TdsCertificate_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
