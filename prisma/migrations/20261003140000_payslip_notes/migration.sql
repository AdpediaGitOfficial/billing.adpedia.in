-- docs/57 · the explanation a payslip carries, frozen when the run was approved

ALTER TABLE "Payslip" ADD COLUMN "tdsNote" TEXT;
ALTER TABLE "Payslip" ADD COLUMN "professionTaxNote" TEXT;
