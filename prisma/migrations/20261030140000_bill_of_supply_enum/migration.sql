-- docs/82 §5 · the document an unregistered entity actually issues
--
-- 🔴 This file adds the enum VALUES and nothing else. docs/65 §6: Prisma runs each migration
-- file in one transaction, and Postgres will not let a new enum value be USED in the
-- transaction that added it. The rows that reference it are the next file.
--
-- An unregistered person must not issue a tax invoice. Rule 49 gives them a BILL OF SUPPLY:
-- no GSTIN, no tax, and a different heading. Billing at 0% on the tax-invoice template would
-- produce a document headed "Tax Invoice" with a GSTIN field — wrong on its face.
ALTER TYPE "DocType" ADD VALUE 'BILL_OF_SUPPLY';
ALTER TYPE "AttachmentKind" ADD VALUE 'BILL_OF_SUPPLY';
