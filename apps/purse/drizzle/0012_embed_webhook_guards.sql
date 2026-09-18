-- Privileges and database-level guards for the phase 4 tables (spec 4.8, 4.9), following
-- the phase 1 role model (docs/decisions.md, "Two Purse database roles"): purse_app gets
-- exactly what the runtime needs per table, column by column where a column legitimately
-- changes, and the database holds the rules a rogue writer could otherwise break, for
-- every role including the owner.
--
--   tenant_origins             SELECT, INSERT; UPDATE on revoked_at: an origin is revoked
--                              (and may be re-added) in place, never deleted or renamed.
--   embed_signin_codes         SELECT, INSERT; UPDATE on attempts and consumed_at. A code
--                              is guessed at most five times and consumed once; a
--                              consumed code is never un-consumed.
--   webhook_endpoints          SELECT, INSERT; UPDATE on url, subscribed_events, status,
--                              description, signing_secret (a rotation) and updated_at.
--                              Never the tenant or the id.
--   webhook_deliveries         SELECT, INSERT; UPDATE on the dispatcher's own columns:
--                              attempt, status, response_status, next_attempt_at,
--                              delivered_at, the lease (locked_until, locked_by) and
--                              updated_at. The event, its payload and the endpoint are
--                              fixed at creation, the attempt count never goes down, and
--                              delivered and dead are terminal.
--   webhook_delivery_attempts  SELECT, INSERT. Every attempt is history (spec 4.9).

GRANT SELECT, INSERT ON TABLE public.tenant_origins TO purse_app;--> statement-breakpoint
GRANT UPDATE (revoked_at) ON TABLE public.tenant_origins TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.embed_signin_codes TO purse_app;--> statement-breakpoint
GRANT UPDATE (attempts, consumed_at) ON TABLE public.embed_signin_codes TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.webhook_endpoints TO purse_app;--> statement-breakpoint
GRANT UPDATE (url, signing_secret, subscribed_events, status, description, updated_at) ON TABLE public.webhook_endpoints TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.webhook_deliveries TO purse_app;--> statement-breakpoint
GRANT UPDATE (attempt, status, response_status, next_attempt_at, delivered_at, locked_until, locked_by, updated_at) ON TABLE public.webhook_deliveries TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.webhook_delivery_attempts TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.tenant_origins, public.embed_signin_codes, public.webhook_endpoints, public.webhook_deliveries, public.webhook_delivery_attempts FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.embed_signin_codes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.phone_e164 <> OLD.phone_e164
    OR NEW.code_hash <> OLD.code_hash
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'sign-in code % is fixed at creation; only attempts and consumed_at may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'embed_signin_codes_guard', TABLE = 'embed_signin_codes';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'sign-in code % has been guessed % times; the count never goes down', OLD.id, OLD.attempts
      USING ERRCODE = 'check_violation', CONSTRAINT = 'embed_signin_codes_guard', TABLE = 'embed_signin_codes';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'sign-in code % was consumed at % and stays consumed', OLD.id, OLD.consumed_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'embed_signin_codes_guard', TABLE = 'embed_signin_codes';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER embed_signin_codes_guard
  BEFORE UPDATE ON public.embed_signin_codes
  FOR EACH ROW EXECUTE FUNCTION public.embed_signin_codes_guard();--> statement-breakpoint

CREATE FUNCTION public.webhook_endpoints_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'webhook endpoint % belongs to its tenant for good', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'webhook_endpoints_guard', TABLE = 'webhook_endpoints';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER webhook_endpoints_guard
  BEFORE UPDATE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.webhook_endpoints_guard();--> statement-breakpoint

CREATE FUNCTION public.webhook_deliveries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.endpoint_id <> OLD.endpoint_id
    OR NEW.event_id <> OLD.event_id
    OR NEW.event_type <> OLD.event_type
    OR NEW.payload <> OLD.payload
    OR NEW.max_attempts <> OLD.max_attempts
    OR NEW.replay_of IS DISTINCT FROM OLD.replay_of
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'webhook delivery % carries one event to one endpoint; only its progress may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'webhook_deliveries_guard', TABLE = 'webhook_deliveries';
  END IF;
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'webhook delivery % has made % attempts; the count never goes down', OLD.id, OLD.attempt
      USING ERRCODE = 'check_violation', CONSTRAINT = 'webhook_deliveries_guard', TABLE = 'webhook_deliveries';
  END IF;
  IF OLD.status IN ('delivered', 'dead') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'webhook delivery % is % and that is final; replay it as a new delivery', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'webhook_deliveries_guard', TABLE = 'webhook_deliveries';
  END IF;
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'webhook delivery % was delivered at % and stays delivered', OLD.id, OLD.delivered_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'webhook_deliveries_guard', TABLE = 'webhook_deliveries';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER webhook_deliveries_guard
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.webhook_deliveries_guard();
