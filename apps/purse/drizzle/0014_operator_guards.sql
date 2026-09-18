-- Privileges and database-level guards for the operator console's tables (spec 4.10),
-- following the phase 1 role model (docs/decisions.md, "Two Purse database roles").
--
--   operators          SELECT; UPDATE on password_hash and updated_at (an operator changes
--                      their own password). Operators are created and disabled by the seed
--                      and the owner, never by the runtime, so no INSERT.
--   operator_sessions  SELECT, INSERT; UPDATE on last_seen_at and revoked_at. A session's
--                      token hash, owner and expiry are fixed at sign-in, and a revoked
--                      session stays revoked.

GRANT SELECT ON TABLE public.operators TO purse_app;--> statement-breakpoint
GRANT UPDATE (password_hash, updated_at) ON TABLE public.operators TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.operator_sessions TO purse_app;--> statement-breakpoint
GRANT UPDATE (last_seen_at, revoked_at) ON TABLE public.operator_sessions TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.operators, public.operator_sessions FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.operators_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.email <> OLD.email OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'operator % keeps its id and email for good', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'operators_guard', TABLE = 'operators';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER operators_guard
  BEFORE UPDATE ON public.operators
  FOR EACH ROW EXECUTE FUNCTION public.operators_guard();--> statement-breakpoint

CREATE FUNCTION public.operator_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.operator_id <> OLD.operator_id
    OR NEW.token_hash <> OLD.token_hash
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'operator session % is fixed at sign-in; only last_seen_at and revoked_at may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'operator_sessions_guard', TABLE = 'operator_sessions';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'operator session % was revoked at % and stays revoked', OLD.id, OLD.revoked_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'operator_sessions_guard', TABLE = 'operator_sessions';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER operator_sessions_guard
  BEFORE UPDATE ON public.operator_sessions
  FOR EACH ROW EXECUTE FUNCTION public.operator_sessions_guard();
