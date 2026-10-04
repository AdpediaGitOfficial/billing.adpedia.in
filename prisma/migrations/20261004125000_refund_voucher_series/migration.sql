-- docs/65 · the REFUND_VOUCHER series for financial years that already exist
--
-- 🔴 Its own migration, and it has to be. Postgres refuses to USE a new enum value in the
-- same transaction that added it — "unsafe use of new value ... of enum type" — and Prisma
-- runs each migration file in one transaction. The ALTER TYPE and the INSERT that references
-- it are therefore two files, in order.
-- 🔴 The series for every financial year that already exists.
--
-- `allocateNumber` refuses with "No REFUND_VOUCHER series for FY … — create it in Settings
-- first", and there is no Settings screen that creates one. On a database seeded before this
-- migration the first refund would fail with an instruction nobody can follow, so the row is
-- created here rather than left to the seed, which only runs on a fresh install.
--
-- ADPF/{FY}/{SEQ:4} renders as ADPF/26-27/0001 — 15 characters, inside rule 46(b)'s sixteen.
INSERT INTO "DocumentSeries" ("id", "companyId", "financialYearId", "docType", "prefix", "pattern", "nextSeq")
SELECT
  md5(random()::text || clock_timestamp()::text),
  s."companyId", s."financialYearId", 'REFUND_VOUCHER', s."prefix", 'ADPF/{FY}/{SEQ:4}', 1
FROM "DocumentSeries" s
WHERE s."docType" = 'TAX_INVOICE'
  AND NOT EXISTS (
    SELECT 1 FROM "DocumentSeries" x
     WHERE x."companyId" = s."companyId"
       AND x."financialYearId" = s."financialYearId"
       AND x."docType" = 'REFUND_VOUCHER'
  );
