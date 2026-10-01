ALTER TABLE "Invoice" ADD COLUMN "billToName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billToAddress" JSONB;
ALTER TABLE "Invoice" ADD COLUMN "billToGstin" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billToStateCode" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billToCountry" TEXT;

-- Backfill issued invoices from the customer as it stands today. This is the best record
-- available: before this column existed the document was always rendered live, so today's
-- customer row IS what those invoices have been showing.
UPDATE "Invoice" i
SET "billToName"      = c."name",
    "billToAddress"   = c."billingAddress",
    "billToGstin"     = c."gstin",
    "billToStateCode" = c."stateCode",
    "billToCountry"   = c."country"
FROM "Customer" c
WHERE c."id" = i."customerId" AND i."status" <> 'DRAFT';
