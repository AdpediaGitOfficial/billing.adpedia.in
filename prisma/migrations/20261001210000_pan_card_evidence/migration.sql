-- docs/47 · PAN cards held on file, and what stands behind a PAN we hold

ALTER TYPE "AttachmentKind" ADD VALUE 'PAN_CARD';

CREATE TYPE "PanEvidence" AS ENUM ('NONE', 'DECLARED', 'CARD_ON_FILE');

ALTER TABLE "Vendor"
  ADD COLUMN "panEvidence" "PanEvidence" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "panEvidenceAt" TIMESTAMP(3),
  ADD COLUMN "panEvidenceById" TEXT;

ALTER TABLE "Employee"
  ADD COLUMN "panEvidence" "PanEvidence" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "panEvidenceAt" TIMESTAMP(3),
  ADD COLUMN "panEvidenceById" TEXT;

-- a PAN already on file was furnished by the payee, which is what s.206AA turns on
UPDATE "Vendor" SET "panEvidence" = 'DECLARED', "panVerified" = true
  WHERE "pan" IS NOT NULL AND "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$';
UPDATE "Employee" SET "panEvidence" = 'DECLARED'
  WHERE "pan" IS NOT NULL AND "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$';
