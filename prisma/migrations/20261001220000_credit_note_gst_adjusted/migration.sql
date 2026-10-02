-- docs/48 · a credit note raised after the s.34(2) deadline recovers no GST

ALTER TABLE "CreditNote"
  ADD COLUMN "gstAdjusted" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "taxNotAdjusted" DECIMAL(18,2) NOT NULL DEFAULT 0;
