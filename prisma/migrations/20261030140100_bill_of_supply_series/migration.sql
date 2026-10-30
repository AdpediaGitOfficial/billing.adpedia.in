-- docs/82 §5 · and the series it is numbered from
--
-- 🔴 docs/65 §6, exactly: "a new document type needs its series backfilled. The seed only runs
-- on a fresh install, and `allocateNumber` refuses with an instruction pointing at a Settings
-- screen that does not exist." Any unregistered company already created would otherwise be
-- unable to issue the one document it is allowed to issue.
--
-- The prefix follows the entity's own tax-invoice prefix with a B — AKF becomes AKFB, which
-- renders AKFB/26-27/0001 at 15 characters, inside Rule 46's 16.
INSERT INTO "DocumentSeries" (id, "companyId", "financialYearId", "docType", prefix, pattern, "nextSeq")
SELECT
  gen_random_uuid()::text,
  s."companyId",
  s."financialYearId",
  'BILL_OF_SUPPLY',
  s.prefix || 'B',
  s.prefix || 'B/{FY}/{SEQ:4}',
  1
FROM "DocumentSeries" s
JOIN "Company" c ON c.id = s."companyId"
WHERE s."docType" = 'TAX_INVOICE'
  AND c."gstRegistrationType" = 'UNREGISTERED'
  AND NOT EXISTS (
    SELECT 1 FROM "DocumentSeries" x
    WHERE x."companyId" = s."companyId"
      AND x."financialYearId" = s."financialYearId"
      AND x."docType" = 'BILL_OF_SUPPLY'
  );
