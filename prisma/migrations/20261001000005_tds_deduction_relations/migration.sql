-- The quarterly return (24Q/26Q/27Q) is deductee-wise: it needs each deductee's name and
-- PAN, not just an id. The columns already exist; this adds the foreign keys so the
-- relation can be traversed and a deduction can never point at a missing party.
ALTER TABLE "TdsDeduction" ADD CONSTRAINT "TdsDeduction_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TdsDeduction" ADD CONSTRAINT "TdsDeduction_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TdsDeduction_vendorId_idx" ON "TdsDeduction"("vendorId");
CREATE INDEX "TdsDeduction_employeeId_idx" ON "TdsDeduction"("employeeId");
