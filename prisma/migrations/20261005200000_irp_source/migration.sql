-- docs/75 · which IRP produced an invoice's IRN
--
-- 🔴 A mock registration writes into the same four columns as a real one. Until this column
-- existed, the only record of which had happened was a line in the audit log — so every
-- consumer of `irn` would read a fake one as genuine, including any document that started
-- printing it.
--
-- Backfilled as 'MOCK — not a real IRP' for every invoice that already carries an IRN: this
-- system has never had a live IRP client (docs/31 §6 makes it a deliberate non-goal), so any
-- IRN on file came from the mock. Leaving them NULL would make "unknown" and "real" the same
-- shape to the renderer, which is the mistake this column exists to prevent.
ALTER TABLE "Invoice" ADD COLUMN "irpSource" TEXT;
UPDATE "Invoice" SET "irpSource" = 'MOCK — not a real IRP' WHERE "irn" IS NOT NULL;
