-- docs/51 · the last two documents that post journals and could not be undone

ALTER TABLE "CreditNote"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT;

ALTER TABLE "GstSetOff"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT;
