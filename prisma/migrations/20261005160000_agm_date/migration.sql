-- docs/72 · the date the AGM was held, which is what every ROC deadline keys off, and the
-- two filings that run from it
--
-- The MCA portal is not something this system talks to, so the filings are recorded by hand.
-- Without a fact to clear them, an annual obligation nags for ever once its date passes — and
-- a calendar that nags is one people stop reading, which is docs/43 §1's whole premise.
ALTER TABLE "FinancialYear" ADD COLUMN "agmHeldOn" TIMESTAMP(3);
ALTER TABLE "FinancialYear" ADD COLUMN "agmSource" TEXT;
ALTER TABLE "FinancialYear" ADD COLUMN "aoc4FiledOn" TIMESTAMP(3);
ALTER TABLE "FinancialYear" ADD COLUMN "mgt7FiledOn" TIMESTAMP(3);
