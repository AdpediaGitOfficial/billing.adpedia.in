-- docs/69 · a refund voucher's journal entry, filed under the voucher rather than the advance
--
-- 🔴 Its own migration, like docs/65's DocType pair and for the same reason: Postgres refuses
-- to USE a new enum value in the transaction that added it, and Prisma runs each file in one
-- transaction. The backfill that references this value is the next file.
ALTER TYPE "SourceType" ADD VALUE 'REFUND_VOUCHER';
