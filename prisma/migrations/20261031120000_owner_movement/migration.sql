-- docs/82 §4 · drawings — money between an owner and their own business
--
-- 🔴 EQUITY, never the P&L. `profitAndLoss` reads INCOME and EXPENSE only, so an equity contra
-- cannot reach it: that is the mechanism that lets rent, groceries and medical bills be
-- recorded in full while the profit the proprietor declares stays where it was.
--
-- 🔴 docs/65 §6's two-file rule applies to USING a new enum value in the migration that adds
-- it. SourceType gains OWNER_MOVEMENT here and nothing in this file references it — the rows
-- that will are written at runtime, long after this transaction commits. CREATE TYPE has no
-- such restriction, so the three new enums are used by the table below in the same file.

ALTER TYPE "SourceType" ADD VALUE 'OWNER_MOVEMENT';

CREATE TYPE "OwnerMovementKind" AS ENUM ('DRAWING', 'CAPITAL');

CREATE TYPE "DrawingPurpose" AS ENUM (
  'RENT', 'HOUSEHOLD', 'MEDICAL', 'EDUCATION', 'INSURANCE_INVESTMENT',
  'PERSONAL_TAX', 'TRANSFER', 'OTHER'
);

CREATE TYPE "MoneySource" AS ENUM ('BANK', 'CASH');

CREATE TABLE "OwnerMovement" (
  "id"              TEXT NOT NULL,
  "companyId"       TEXT NOT NULL,
  "financialYearId" TEXT NOT NULL,
  "kind"            "OwnerMovementKind" NOT NULL,
  "purpose"         "DrawingPurpose",
  "date"            TIMESTAMP(3) NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "source"          "MoneySource" NOT NULL DEFAULT 'BANK',
  "bankAccountId"   TEXT,
  "narration"       TEXT NOT NULL,
  "createdById"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OwnerMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OwnerMovement_companyId_date_idx" ON "OwnerMovement"("companyId", "date");
CREATE INDEX "OwnerMovement_companyId_kind_idx" ON "OwnerMovement"("companyId", "kind");

ALTER TABLE "OwnerMovement" ADD CONSTRAINT "OwnerMovement_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerMovement" ADD CONSTRAINT "OwnerMovement_financialYearId_fkey"
  FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 🔴 A drawing is a financial record, so it gets the same guard every other one has: no hard
-- delete. A drawing entered wrongly is corrected by a CAPITAL movement for the same amount —
-- the pair reads as what happened, which is what the money trail is for.
CREATE TRIGGER no_delete_owner_movement BEFORE DELETE ON "OwnerMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
