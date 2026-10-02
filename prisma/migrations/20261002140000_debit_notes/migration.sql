-- docs/53 · s.34(3) debit notes, in the same table as credit notes

CREATE TYPE "NoteType" AS ENUM ('CREDIT', 'DEBIT');

ALTER TABLE "CreditNote" ADD COLUMN "noteType" "NoteType" NOT NULL DEFAULT 'CREDIT';
