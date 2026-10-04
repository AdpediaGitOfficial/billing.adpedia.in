-- docs/76 · the two annual tax returns, recorded beside the two ROC ones
--
-- Both are filed on a government portal this system does not talk to, and both are about a
-- financial year that has ENDED — which is what docs/72 §2 left open about the calendar
-- reading the current year for them.
ALTER TABLE "FinancialYear" ADD COLUMN "gstr9FiledOn" TIMESTAMP(3);
ALTER TABLE "FinancialYear" ADD COLUMN "gstr9Arn" TEXT;
ALTER TABLE "FinancialYear" ADD COLUMN "itrFiledOn" TIMESTAMP(3);
ALTER TABLE "FinancialYear" ADD COLUMN "itrAckNo" TEXT;
