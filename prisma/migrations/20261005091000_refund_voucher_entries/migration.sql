-- docs/69 · re-file the refund entries that were posted under the advance's identity
--
-- `createRefundVoucher` posted with `sourceType: 'RECEIPT'` and the RECEIPT's id, because
-- SourceType had no member of its own. Two consequences, both fixed by moving them:
--
--   1. 🔴 `cancelReceipt` reverses every entry filed under the receipt's id, so cancelling a
--      refunded advance also reversed the refund — while the RefundVoucher row stayed live
--      and kept being reported in GSTR-1 table 11B.
--   2. Nothing could find a voucher's entry, so `cancelRefundVoucher` could not be written.
--
-- Matched on the narration, which `createRefundVoucher` has always written as
-- "Refund voucher {number} — ...", and the number is unique per company.
UPDATE "JournalEntry" e
   SET "sourceType" = 'REFUND_VOUCHER', "sourceId" = v."id"
  FROM "RefundVoucher" v
 WHERE e."companyId" = v."companyId"
   AND e."sourceType" = 'RECEIPT'
   AND e."sourceId"   = v."receiptId"
   AND e."narration" LIKE 'Refund voucher ' || v."number" || ' %';
