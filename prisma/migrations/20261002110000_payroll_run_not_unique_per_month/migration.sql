-- docs/50 · a cancelled run keeps its row, so the month must be runnable again

DROP INDEX "PayrollRun_companyId_year_month_key";
CREATE INDEX "PayrollRun_companyId_year_month_idx" ON "PayrollRun"("companyId", "year", "month");
