-- docs/71 · account 1350, for every company that already exists
--
-- 🔴 The seed only runs on a fresh install — docs/65 §6's lesson, applied before it bites
-- rather than after. Without this row, the first advance-tax payment on an existing database
-- fails inside postJournal with "account 1350 not found", and there is no screen that creates
-- an account.
--
-- An ASSET, not an expense. Advance tax is money paid on account against a liability the
-- return has not yet settled; booking it as an expense understates the year's profit by
-- whatever has been paid, and then double-counts when the final tax is provided for.
INSERT INTO "Account" ("id", "companyId", "code", "name", "type", "parentId", "isSystem", "isActive")
SELECT
  md5(random()::text || clock_timestamp()::text),
  c."id", '1350', 'Advance Income Tax Paid', 'ASSET', NULL, true, true
FROM "Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."companyId" = c."id" AND a."code" = '1350'
);
