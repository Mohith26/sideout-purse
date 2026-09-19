-- Privileges and database-level guards for the signed score attestation table (system spec
-- section 12, item 1), following the phase 1 role model (docs/decisions.md, "Two Purse
-- database roles").
--
--   user_devices     SELECT, INSERT; UPDATE on revoked_at, revoked_by, revoked_reason and
--                    updated_at. The key, its id, its owner and its label are fixed at
--                    registration, and a revocation is never undone: a device that comes
--                    back is registered again as a new row.
--   contest_scores   unchanged: SELECT, INSERT and UPDATE (superseded_by) only. The two new
--                    columns (attestation_state, attestation) are written at insert and
--                    never change, which the column-level grant already guarantees.

GRANT SELECT, INSERT ON TABLE public.user_devices TO purse_app;--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by, revoked_reason, updated_at) ON TABLE public.user_devices TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.user_devices FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.user_devices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.user_id <> OLD.user_id
    OR NEW.key_id <> OLD.key_id
    OR NEW.algorithm <> OLD.algorithm
    OR NEW.public_key <> OLD.public_key
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'device % is fixed at registration; only its revocation may be recorded', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_devices_guard', TABLE = 'user_devices';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'device % was revoked at % and stays revoked', OLD.id, OLD.revoked_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_devices_guard', TABLE = 'user_devices';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER user_devices_guard
  BEFORE UPDATE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.user_devices_guard();
