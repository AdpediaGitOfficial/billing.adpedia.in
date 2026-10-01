-- =============================================================================
-- Non-negotiable #1 (docs/10 §3.1): every journal entry balances.
--
-- This is the SECOND of two independent checks. The first is assertBalanced()
-- in src/server/services/accounting/journal.ts. Application code can be
-- bypassed — a raw SQL insert, a migration, a future service. This cannot.
--
-- DEFERRABLE INITIALLY DEFERRED so lines can be inserted after the entry
-- within the same transaction; the check fires once, at COMMIT.
-- =============================================================================

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
  total_debit  NUMERIC(18,2);
  total_credit NUMERIC(18,2);
  line_count   INTEGER;
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
    INTO total_debit, total_credit, line_count
    FROM "JournalLine"
   WHERE "journalEntryId" = NEW.id;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'Journal entry % has no lines', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debit % <> credit % (difference %)',
      NEW.id, total_debit, total_credit, (total_debit - total_credit)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entry_must_balance
  AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- A line may not carry both a debit and a credit, and neither may be negative.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT journal_line_single_sided
  CHECK (
    debit  >= 0 AND credit >= 0
    AND NOT (debit > 0 AND credit > 0)
    AND (debit > 0 OR credit > 0)
  );

-- =============================================================================
-- Non-negotiable #4: nothing is hard-deleted.
-- Cancellation is a status change plus a reversal entry.
-- =============================================================================

CREATE OR REPLACE FUNCTION refuse_hard_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Refusing to delete from %: financial records are never hard-deleted. Cancel and post a reversal instead.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_delete_journal_entry  BEFORE DELETE ON "JournalEntry"  FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
CREATE TRIGGER no_delete_invoice        BEFORE DELETE ON "Invoice"       FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
CREATE TRIGGER no_delete_receipt        BEFORE DELETE ON "Receipt"       FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
CREATE TRIGGER no_delete_vendor_bill    BEFORE DELETE ON "VendorBill"    FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
CREATE TRIGGER no_delete_tds_deduction  BEFORE DELETE ON "TdsDeduction"  FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();
CREATE TRIGGER no_delete_audit_log      BEFORE DELETE ON "AuditLog"      FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();

-- AuditLog is append-only: no updates either.
CREATE OR REPLACE FUNCTION refuse_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_audit_log BEFORE UPDATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION refuse_update();
