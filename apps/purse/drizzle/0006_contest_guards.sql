-- Privileges and database-level guards for the contest tables (spec 4.1, 4.3), following
-- the phase 1 role model (docs/decisions.md, "Two Purse database roles"): purse_app gets
-- exactly what the runtime needs per table, column by column where a column legitimately
-- changes, and the database holds the rules a rogue writer could otherwise break.
--
--   contests              SELECT, INSERT; UPDATE on state, settled_at, locks_at, the fields
--                         a draft may edit, and updated_at. Never asset, tenant_id,
--                         external_id or escrow_account_id: those define the contest and
--                         what its escrow may hold.
--   contest_participants  SELECT, INSERT; UPDATE on state and updated_at only. The entry
--                         link (entry_journal_entry_id) is written once, at entry.
--   contest_scores        SELECT, INSERT; UPDATE on superseded_by only (append-only chain).
--   contest_results       SELECT, INSERT. Written once at settlement, never changed.
--   idempotency_keys      SELECT, INSERT. A used key is history.
--
-- Guards, enforced for every role including the owner:
--   contests_state_machine         the spec 4.3 transitions, the same table as
--                                  src/contests/states.ts (test/contests/transition.test.ts
--                                  proves the two agree pair for pair);
--   contests_frozen_after_draft    the defining fields cannot change once a contest has
--                                  left draft, and the identity fields never change;
--   contest_participants_guard     the identity of an entry never changes and its state
--                                  only moves entered -> withdrawn | disqualified, and
--                                  disqualified -> entered;
--   contest_scores_supersede_once  a score is superseded at most once, never once its
--                                  attempt is finished, only by a newer score for the same
--                                  contest and user, and nothing else about it changes;
--   contest_scores_current_key     one counting score (superseded_by is null) per user per
--                                  contest. A deferrable exclusion constraint rather than a
--                                  partial unique index, because the new score is inserted
--                                  before the old one is pointed at it and both must exist
--                                  at commit; drizzle cannot express it, so it lives here.

GRANT SELECT, INSERT ON TABLE public.contests TO purse_app;--> statement-breakpoint
GRANT UPDATE (state, settled_at, locks_at, opens_at, title, kind, entry_amount, max_participants, prize_structure, tie_break, settlement_policy, eligibility_ruleset_version, updated_at) ON TABLE public.contests TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.contest_participants TO purse_app;--> statement-breakpoint
GRANT UPDATE (state, updated_at) ON TABLE public.contest_participants TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.contest_scores TO purse_app;--> statement-breakpoint
GRANT UPDATE (superseded_by) ON TABLE public.contest_scores TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.contest_results TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.idempotency_keys TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.contest_results, public.idempotency_keys FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.contests_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'draft' AND NEW.state IN ('open', 'cancelled'))
    OR (OLD.state = 'open' AND NEW.state IN ('locked', 'cancelled', 'voided'))
    OR (OLD.state = 'locked' AND NEW.state IN ('in_progress', 'cancelled', 'voided'))
    OR (OLD.state = 'in_progress' AND NEW.state IN ('awaiting_settlement', 'cancelled', 'voided'))
    OR (OLD.state = 'awaiting_settlement' AND NEW.state IN ('settling', 'cancelled', 'voided'))
    OR (OLD.state = 'settling' AND NEW.state = 'settled')
  ) THEN
    RAISE EXCEPTION 'contest % cannot move from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contests_state_machine', TABLE = 'contests';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER contests_state_machine
  BEFORE UPDATE OF state ON public.contests
  FOR EACH ROW EXECUTE FUNCTION public.contests_state_machine();--> statement-breakpoint

CREATE FUNCTION public.contests_frozen_after_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.external_id <> OLD.external_id
    OR NEW.asset <> OLD.asset
    OR NEW.escrow_account_id <> OLD.escrow_account_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'contest % identity fields cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contests_frozen_after_draft', TABLE = 'contests';
  END IF;
  IF OLD.state <> 'draft' AND (
    NEW.title IS DISTINCT FROM OLD.title
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.entry_amount IS DISTINCT FROM OLD.entry_amount
    OR NEW.max_participants IS DISTINCT FROM OLD.max_participants
    OR NEW.prize_structure IS DISTINCT FROM OLD.prize_structure
    OR NEW.tie_break IS DISTINCT FROM OLD.tie_break
    OR NEW.settlement_policy IS DISTINCT FROM OLD.settlement_policy
    OR NEW.opens_at IS DISTINCT FROM OLD.opens_at
    OR NEW.eligibility_ruleset_version IS DISTINCT FROM OLD.eligibility_ruleset_version
  ) THEN
    RAISE EXCEPTION 'contest % is %, not draft; its defining fields are frozen', OLD.id, OLD.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contests_frozen_after_draft', TABLE = 'contests';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER contests_frozen_after_draft
  BEFORE UPDATE ON public.contests
  FOR EACH ROW EXECUTE FUNCTION public.contests_frozen_after_draft();--> statement-breakpoint

CREATE FUNCTION public.contest_participants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.contest_id <> OLD.contest_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.entry_journal_entry_id <> OLD.entry_journal_entry_id
    OR NEW.joined_at <> OLD.joined_at
    OR NEW.team_ref IS DISTINCT FROM OLD.team_ref
    OR NEW.seed IS DISTINCT FROM OLD.seed THEN
    RAISE EXCEPTION 'participant % identity fields cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_participants_guard', TABLE = 'contest_participants';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'entered' AND NEW.state IN ('withdrawn', 'disqualified'))
    OR (OLD.state = 'disqualified' AND NEW.state = 'entered')
  ) THEN
    RAISE EXCEPTION 'participant % cannot move from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_participants_guard', TABLE = 'contest_participants';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER contest_participants_guard
  BEFORE UPDATE ON public.contest_participants
  FOR EACH ROW EXECUTE FUNCTION public.contest_participants_guard();--> statement-breakpoint

CREATE FUNCTION public.contest_scores_supersede_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  newer public.contest_scores%ROWTYPE;
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.contest_id <> OLD.contest_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.score IS DISTINCT FROM OLD.score
    OR NEW.attempt_finished <> OLD.attempt_finished
    OR NEW.submitted_at <> OLD.submitted_at
    OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
    RAISE EXCEPTION 'score % is append-only; only superseded_by may be set', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_scores_supersede_once', TABLE = 'contest_scores';
  END IF;
  IF NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by THEN
    RETURN NEW;
  END IF;
  IF NEW.superseded_by IS NULL THEN
    RAISE EXCEPTION 'score % cannot be un-superseded', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_scores_supersede_once', TABLE = 'contest_scores';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'score % was already superseded by %', OLD.id, OLD.superseded_by
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_scores_supersede_once', TABLE = 'contest_scores';
  END IF;
  IF OLD.attempt_finished THEN
    RAISE EXCEPTION 'score % is a finished attempt and cannot be superseded', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_scores_supersede_once', TABLE = 'contest_scores';
  END IF;
  SELECT * INTO newer FROM public.contest_scores WHERE id = NEW.superseded_by;
  IF newer.id IS NULL OR newer.contest_id <> OLD.contest_id OR newer.user_id <> OLD.user_id OR newer.submitted_at < OLD.submitted_at THEN
    RAISE EXCEPTION 'score % can only be superseded by a newer score for the same contest and user', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contest_scores_supersede_once', TABLE = 'contest_scores';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER contest_scores_supersede_once
  BEFORE UPDATE ON public.contest_scores
  FOR EACH ROW EXECUTE FUNCTION public.contest_scores_supersede_once();--> statement-breakpoint

ALTER TABLE public.contest_scores
  ADD CONSTRAINT contest_scores_current_key
  EXCLUDE USING btree (contest_id WITH =, user_id WITH =) WHERE (superseded_by IS NULL)
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

DO $$
DECLARE
  t text;
  c text;
BEGIN
  IF current_user = 'purse_app' THEN
    RAISE EXCEPTION 'migrations must run as the owner role (purse_migrator), not as the runtime role';
  END IF;

  FOREACH t IN ARRAY ARRAY['contests', 'contest_participants', 'contest_scores', 'contest_results', 'idempotency_keys'] LOOP
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
  END LOOP;

  FOREACH c IN ARRAY ARRAY['state', 'settled_at', 'locks_at', 'updated_at'] LOOP
    IF NOT has_column_privilege('purse_app', 'public.contests', c, 'UPDATE') THEN
      RAISE EXCEPTION 'purse_app did not receive UPDATE on public.contests.%', c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['id', 'tenant_id', 'external_id', 'asset', 'escrow_account_id', 'created_at'] LOOP
    IF has_column_privilege('purse_app', 'public.contests', c, 'UPDATE') THEN
      RAISE EXCEPTION 'purse_app must not hold UPDATE on public.contests.%', c;
    END IF;
  END LOOP;
  IF NOT has_column_privilege('purse_app', 'public.contest_participants', 'state', 'UPDATE')
    OR has_column_privilege('purse_app', 'public.contest_participants', 'entry_journal_entry_id', 'UPDATE') THEN
    RAISE EXCEPTION 'purse_app column privileges on public.contest_participants are wrong';
  END IF;
  IF NOT has_column_privilege('purse_app', 'public.contest_scores', 'superseded_by', 'UPDATE')
    OR has_column_privilege('purse_app', 'public.contest_scores', 'score', 'UPDATE') THEN
    RAISE EXCEPTION 'purse_app column privileges on public.contest_scores are wrong';
  END IF;
  FOREACH t IN ARRAY ARRAY['contest_results', 'idempotency_keys'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.column_privileges
      WHERE grantee = 'purse_app' AND table_schema = 'public' AND table_name = t AND privilege_type = 'UPDATE'
    ) THEN
      RAISE EXCEPTION 'purse_app must not hold UPDATE on any column of public.%', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['contests_state_machine', 'contests_frozen_after_draft', 'contest_participants_guard', 'contest_scores_supersede_once'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'trigger % is missing or disabled', t;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contest_scores_current_key' AND contype = 'x' AND condeferrable AND condeferred
  ) THEN
    RAISE EXCEPTION 'contest_scores_current_key is missing or not deferred';
  END IF;
END $$;
