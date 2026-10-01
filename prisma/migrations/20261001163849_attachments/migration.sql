CREATE TYPE "AttachmentKind" AS ENUM ('RECEIPT', 'VENDOR_INVOICE', 'PAYSLIP', 'FORM_26AS', 'CHALLAN', 'BANK_STATEMENT', 'OTHER');

CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
CREATE INDEX "Attachment_companyId_entityType_entityId_idx" ON "Attachment"("companyId", "entityType", "entityId");
CREATE INDEX "Attachment_companyId_sha256_idx" ON "Attachment"("companyId", "sha256");

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
