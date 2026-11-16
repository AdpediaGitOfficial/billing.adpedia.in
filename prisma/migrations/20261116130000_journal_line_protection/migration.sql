-- =============================================================================
-- docs/95 — the second check on the ledger was only a check on the ENTRY.
--
-- assert_journal_balanced() fires on INSERT/UPDATE of "JournalEntry". Nothing fired when a
-- LINE changed, so after commit:
--   * DELETE FROM "JournalLine" removed one side of an entry and nothing objected,
--   * UPDATE "JournalLine" SET debit = ... changed an amount and nothing re-checked it,
--   * INSERT INTO "JournalLine" added a one-sided line to a posted entry.
-- The application never does any of these; this makes it so nobody can.
-- =============================================================================

-- 1. Any change that leaves an entry unbalanced is refused at COMMIT.
CREATE OR REPLACE FUNCTION assert_journal_line_balanced() RETURNS TRIGGER AS $$
DECLARE
  total_debit  NUMERIC(18,2);
  total_credit NUMERIC(18,2);
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM "JournalLine"
   WHERE "journalEntryId" = NEW."journalEntryId";

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced after a line change: debit % <> credit % (difference %)',
      NEW."journalEntryId", total_debit, total_credit, (total_debit - total_credit)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Deferred like the entry's own trigger: an entry and its lines are inserted in one transaction,
-- and the check has to see all of them.
CREATE CONSTRAINT TRIGGER journal_line_must_balance
  AFTER INSERT OR UPDATE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_line_balanced();

-- 2. A posted line is never deleted. (A cancelled document posts a reversal — design rule 2.)
CREATE TRIGGER no_delete_journal_line BEFORE DELETE ON "JournalLine"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_hard_delete();

-- 3. A posted line's amount, account and entry are never rewritten. The party and project
--    columns are left alone: ON DELETE SET NULL on those foreign keys writes them.
CREATE OR REPLACE FUNCTION refuse_journal_line_rewrite() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."accountId"      IS DISTINCT FROM OLD."accountId"
  OR NEW.debit            IS DISTINCT FROM OLD.debit
  OR NEW.credit           IS DISTINCT FROM OLD.credit
  OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" THEN
    RAISE EXCEPTION 'Refusing to rewrite journal line %: a posted line is never edited. Post a reversal instead.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_rewrite_journal_line BEFORE UPDATE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION refuse_journal_line_rewrite();
