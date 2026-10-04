-- docs/66 · s.37(3), GSTR-1 table 9C — amending a credit or debit note already filed

CREATE TABLE "GstNoteAmendment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "originalPeriod" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "revisedTaxableValue" DECIMAL(18,2) NOT NULL,
    "revisedCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revisedSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revisedIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revisedGrandTotal" DECIMAL(18,2) NOT NULL,
    "originalTaxableValue" DECIMAL(18,2) NOT NULL,
    "originalCgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "originalSgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "originalIgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GstNoteAmendment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GstNoteAmendment_companyId_periodLabel_idx" ON "GstNoteAmendment"("companyId", "periodLabel");
CREATE INDEX "GstNoteAmendment_companyId_noteId_idx" ON "GstNoteAmendment"("companyId", "noteId");

ALTER TABLE "GstNoteAmendment" ADD CONSTRAINT "GstNoteAmendment_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
