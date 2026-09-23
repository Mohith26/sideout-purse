-- Treasury grants and guards (spec section 13).
--
-- The split mirrors the ledger's: a payment is a mutable position that advances through a
-- state machine, but its history is not. The runtime may update `payments`, and may only
-- append to `payment_events`, so the story of a dollar cannot be rewritten after the fact
-- any more than the journal can. Neither table grants DELETE to anyone but the owner.
GRANT SELECT, INSERT, UPDATE ON TABLE payment_methods TO purse_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE payments TO purse_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE payment_events TO purse_app;
--> statement-breakpoint

-- A terminal payment is finished. The row-level CHECKs constrain which states a direction
-- may hold, but nothing in them stops a settled deposit being dragged back to `authorized`
-- by a bad code path, which would silently unbalance I8. This does, in the database, for
-- every writer including the owner role.
CREATE OR REPLACE FUNCTION payments_refuse_terminal_change() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('settled', 'paid', 'failed', 'cancelled', 'refunded', 'returned')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'payment % is terminal in state %, and cannot move to %',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  -- The ledger leg is written once, when the payment funds, and never rewritten.
  IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'payment % already carries ledger entry %, which cannot be replaced by %',
      OLD.id, OLD.journal_entry_id, NEW.journal_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_refuse_terminal_change
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_refuse_terminal_change();
--> statement-breakpoint

-- A funded payment's ledger entry must be the matching kind and direction. This is I8
-- made structural: the service cannot link a deposit to a withdrawal's entry, or to a
-- settlement, even by mistake.
CREATE OR REPLACE FUNCTION payments_check_ledger_leg() RETURNS trigger AS $$
DECLARE
  entry_kind text;
BEGIN
  IF NEW.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind::text INTO entry_kind FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF entry_kind IS DISTINCT FROM NEW.direction::text THEN
    RAISE EXCEPTION 'payment % is a % but its ledger entry % is a %',
      NEW.id, NEW.direction, NEW.journal_entry_id, coalesce(entry_kind, 'missing entry')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_check_ledger_leg
  AFTER INSERT OR UPDATE ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payments_check_ledger_leg();
