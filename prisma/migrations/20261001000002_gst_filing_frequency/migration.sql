-- QRMP: businesses under ₹5 crore turnover may file GSTR-1/3B quarterly while
-- still paying tax monthly. Adpedia is well under the threshold.
CREATE TYPE "GstFilingFrequency" AS ENUM ('MONTHLY', 'QUARTERLY');

ALTER TABLE "Company"
  ADD COLUMN "gstFilingFrequency" "GstFilingFrequency" NOT NULL DEFAULT 'QUARTERLY';
