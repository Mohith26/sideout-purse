-- Privileges and database-level guards for the phase 3 tables (spec 4.1, 4.5, 4.6),
-- following the phase 1 role model (docs/decisions.md, "Two Purse database roles"):
-- purse_app gets exactly what the runtime needs per table, column by column where a column
-- legitimately changes, and the database holds the rules a rogue writer could otherwise
-- break, for every role including the owner.
--
--   users                  SELECT, INSERT; UPDATE on the demographics a partner upsert may
--                          correct (display_name, phone_e164, date_of_birth) and updated_at.
--                          Never id, tenant_id or created_at; external_id only to claim a
--                          `legacy:` placeholder from the 0007 backfill (seed, owner role).
--   user_verification      SELECT, INSERT; UPDATE on the state machine's own columns. The
--                          graph (unstarted -> pending -> verified | rejected, verified ->
--                          pending to re-verify, rejected -> unstarted only by an operator
--                          reset) is held by a trigger. There is no column that could hold
--                          a document, and provider_ref is held to an opaque token shape.
--   user_restrictions      SELECT, INSERT; UPDATE on lifted_at, lifted_by and updated_at.
--                          A restriction is lifted once and never un-lifted; nothing else
--                          about it changes.
--   user_locations         SELECT, INSERT; UPDATE on every resolution field: the row is
--                          the user's current location and is overwritten on re-resolution.
--   rulesets               SELECT, INSERT; UPDATE on active and updated_at. A version's body
--                          never changes once written.
--   eligibility_decisions  SELECT, INSERT. One row per entry attempt, forever.
--   identity_fingerprints  SELECT, INSERT; UPDATE on fingerprint and computed_at (recomputed
--                          when a name or date of birth changes).
--   operator_flags         SELECT, INSERT; UPDATE on status, reviewed_at, reviewed_by and
--                          updated_at. What was flagged never changes; its review does.
--   api_keys               SELECT, INSERT; UPDATE on last_used_at, revoked_at and updated_at.
--                          The hash, prefix, kind, environment and scopes are fixed at
--                          creation and a revocation is never undone.
--   embed_tokens           SELECT, INSERT; UPDATE on consumed_at only, once.
--   accounts               unchanged: user_id is written at open and never updated.
--   idempotency_keys       unchanged from 0006: SELECT, INSERT for both scopes.

GRANT SELECT, INSERT ON TABLE public.users TO purse_app;--> statement-breakpoint
GRANT UPDATE (display_name, phone_e164, date_of_birth, updated_at) ON TABLE public.users TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.user_verification TO purse_app;--> statement-breakpoint
GRANT UPDATE (state, provider, provider_ref, verified_at, reverify_after, updated_at) ON TABLE public.user_verification TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.user_restrictions TO purse_app;--> statement-breakpoint
GRANT UPDATE (lifted_at, lifted_by, updated_at) ON TABLE public.user_restrictions TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.user_locations TO purse_app;--> statement-breakpoint
GRANT UPDATE (region_code, source, resolved_at, confidence, updated_at) ON TABLE public.user_locations TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.rulesets TO purse_app;--> statement-breakpoint
GRANT UPDATE (active, updated_at) ON TABLE public.rulesets TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.eligibility_decisions TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.identity_fingerprints TO purse_app;--> statement-breakpoint
GRANT UPDATE (fingerprint, computed_at) ON TABLE public.identity_fingerprints TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.operator_flags TO purse_app;--> statement-breakpoint
GRANT UPDATE (status, reviewed_at, reviewed_by, updated_at) ON TABLE public.operator_flags TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.api_keys TO purse_app;--> statement-breakpoint
GRANT UPDATE (last_used_at, revoked_at, updated_at) ON TABLE public.api_keys TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.embed_tokens TO purse_app;--> statement-breakpoint
GRANT UPDATE (consumed_at) ON TABLE public.embed_tokens TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.eligibility_decisions, public.api_keys, public.embed_tokens, public.user_verification FROM PUBLIC;--> statement-breakpoint

-- A user's identity fields never change, with one exception: the `legacy:<id>` external id
-- the 0007 backfill gave a placeholder user may be claimed once by the partner's real one.
CREATE FUNCTION public.users_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'user % identity fields cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_guard', TABLE = 'users';
  END IF;
  IF NEW.external_id <> OLD.external_id AND OLD.external_id NOT LIKE 'legacy:%' THEN
    RAISE EXCEPTION 'user % identity fields cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_guard', TABLE = 'users';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER users_guard
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_guard();--> statement-breakpoint

CREATE FUNCTION public.user_verification_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'verification of % cannot move to another user', OLD.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_verification_state_machine', TABLE = 'user_verification';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'unstarted' AND NEW.state = 'pending')
    OR (OLD.state = 'pending' AND NEW.state IN ('verified', 'rejected'))
    OR (OLD.state = 'verified' AND NEW.state = 'pending')
    OR (OLD.state = 'rejected' AND NEW.state = 'unstarted')
  ) THEN
    RAISE EXCEPTION 'verification of % cannot move from % to %', OLD.user_id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_verification_state_machine', TABLE = 'user_verification';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER user_verification_state_machine
  BEFORE UPDATE ON public.user_verification
  FOR EACH ROW EXECUTE FUNCTION public.user_verification_state_machine();--> statement-breakpoint

CREATE FUNCTION public.user_restrictions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.user_id <> OLD.user_id
    OR NEW.kind <> OLD.kind
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.starts_at <> OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'restriction % is fixed once written; only lifted_at and lifted_by may be set', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_restrictions_guard', TABLE = 'user_restrictions';
  END IF;
  IF OLD.lifted_at IS NOT NULL AND (NEW.lifted_at IS DISTINCT FROM OLD.lifted_at OR NEW.lifted_by IS DISTINCT FROM OLD.lifted_by) THEN
    RAISE EXCEPTION 'restriction % was already lifted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_restrictions_guard', TABLE = 'user_restrictions';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER user_restrictions_guard
  BEFORE UPDATE ON public.user_restrictions
  FOR EACH ROW EXECUTE FUNCTION public.user_restrictions_guard();--> statement-breakpoint

CREATE FUNCTION public.rulesets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> OLD.version OR NEW.body <> OLD.body OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'ruleset % is fixed once written; only active may change', OLD.version
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rulesets_guard', TABLE = 'rulesets';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER rulesets_guard
  BEFORE UPDATE ON public.rulesets
  FOR EACH ROW EXECUTE FUNCTION public.rulesets_guard();--> statement-breakpoint

CREATE FUNCTION public.operator_flags_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.kind <> OLD.kind
    OR NEW.subject <> OLD.subject
    OR NEW.dedupe_key <> OLD.dedupe_key
    OR NEW.detail <> OLD.detail
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'flag % is fixed once written; only its review may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'operator_flags_guard', TABLE = 'operator_flags';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER operator_flags_guard
  BEFORE UPDATE ON public.operator_flags
  FOR EACH ROW EXECUTE FUNCTION public.operator_flags_guard();--> statement-breakpoint

CREATE FUNCTION public.api_keys_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.kind <> OLD.kind
    OR NEW.environment <> OLD.environment
    OR NEW.key_prefix <> OLD.key_prefix
    OR NEW.key_hash <> OLD.key_hash
    OR NEW.scopes <> OLD.scopes
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'api key % is fixed at creation; only last_used_at and revoked_at may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard', TABLE = 'api_keys';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'api key % was revoked at % and stays revoked', OLD.id, OLD.revoked_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard', TABLE = 'api_keys';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER api_keys_guard
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard();--> statement-breakpoint

CREATE FUNCTION public.embed_tokens_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.flow <> OLD.flow
    OR NEW.token_hash <> OLD.token_hash
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'embed token % is fixed at creation; only consumed_at may be set', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'embed_tokens_guard', TABLE = 'embed_tokens';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'embed token % was already consumed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'embed_tokens_guard', TABLE = 'embed_tokens';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER embed_tokens_guard
  BEFORE UPDATE ON public.embed_tokens
  FOR EACH ROW EXECUTE FUNCTION public.embed_tokens_guard();--> statement-breakpoint

DO $$
DECLARE
  t text;
  c text;
  updatable text[];
  expected text[];
  spec text[][] := ARRAY[
    ARRAY['users', 'date_of_birth,display_name,phone_e164,updated_at'],
    ARRAY['user_verification', 'provider,provider_ref,reverify_after,state,updated_at,verified_at'],
    ARRAY['user_restrictions', 'lifted_at,lifted_by,updated_at'],
    ARRAY['user_locations', 'confidence,region_code,resolved_at,source,updated_at'],
    ARRAY['rulesets', 'active,updated_at'],
    ARRAY['eligibility_decisions', ''],
    ARRAY['identity_fingerprints', 'computed_at,fingerprint'],
    ARRAY['operator_flags', 'reviewed_at,reviewed_by,status,updated_at'],
    ARRAY['api_keys', 'last_used_at,revoked_at,updated_at'],
    ARRAY['embed_tokens', 'consumed_at']
  ];
BEGIN
  IF current_user = 'purse_app' THEN
    RAISE EXCEPTION 'migrations must run as the owner role (purse_migrator), not as the runtime role';
  END IF;

  FOR i IN 1 .. array_length(spec, 1) LOOP
    t := spec[i][1];
    expected := CASE WHEN spec[i][2] = '' THEN ARRAY[]::text[] ELSE string_to_array(spec[i][2], ',') END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t AND tableowner = current_user
    ) THEN
      RAISE EXCEPTION 'table public.% is not owned by %', t, current_user;
    END IF;
    IF NOT has_table_privilege('purse_app', format('public.%I', t), 'SELECT')
      OR NOT has_table_privilege('purse_app', format('public.%I', t), 'INSERT') THEN
      RAISE EXCEPTION 'purse_app did not receive SELECT and INSERT on public.%', t;
    END IF;
    IF has_table_privilege('purse_app', format('public.%I', t), 'UPDATE')
      OR has_table_privilege('purse_app', format('public.%I', t), 'DELETE')
      OR has_table_privilege('purse_app', format('public.%I', t), 'TRUNCATE') THEN
      RAISE EXCEPTION 'purse_app must not hold table-level UPDATE, DELETE or TRUNCATE on public.%', t;
    END IF;
    SELECT coalesce(array_agg(column_name::text ORDER BY column_name), ARRAY[]::text[]) INTO updatable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t
        AND has_column_privilege('purse_app', format('public.%I', t), column_name, 'UPDATE');
    IF updatable <> expected THEN
      RAISE EXCEPTION 'purse_app may update % of public.%; expected %', updatable, t, expected;
    END IF;
  END LOOP;

  IF has_column_privilege('purse_app', 'public.accounts', 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'purse_app must not hold UPDATE on public.accounts.user_id';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE kind = 'user_wallet' AND user_id IS NULL) THEN
    RAISE EXCEPTION 'a user_wallet account has no user_id after the phase 3 backfill';
  END IF;

  FOREACH t IN ARRAY ARRAY['users_guard', 'user_verification_state_machine', 'user_restrictions_guard', 'rulesets_guard', 'operator_flags_guard', 'api_keys_guard', 'embed_tokens_guard'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'trigger % is missing or disabled', t;
    END IF;
  END LOOP;
END $$;
