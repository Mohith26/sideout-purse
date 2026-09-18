-- Privileges for the runtime role. Spec 4.2.2 rule 5: the journal is append-only and that
-- is enforced at the database role level, not by convention.
--
-- Two roles (docs/decisions.md, "Two Purse database roles"):
--   purse_migrator  owns the databases and every object in them; runs migrations and seeds.
--   purse_app       the API's runtime role. Owns nothing, can grant nothing, and holds
--                   exactly the privileges below. Anything not granted here is refused.
--
-- This file runs as purse_migrator, the owner, which is the only role that can grant.
-- The DO block at the end turns a silent "no privileges were granted" warning (what
-- Postgres emits when a non-owner grants) into a hard failure.

GRANT USAGE ON SCHEMA public TO purse_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA drizzle TO purse_app;--> statement-breakpoint
-- /health reports migration state, so the runtime may read (only read) the migrations table.
GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO purse_app;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE public.tenants TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.accounts TO purse_app;--> statement-breakpoint

-- Append-only tables: SELECT and INSERT, nothing else, ever.
GRANT SELECT, INSERT ON TABLE public.journal_entries TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.journal_lines TO purse_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.audit_log TO purse_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.journal_entries, public.journal_lines, public.audit_log FROM purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.journal_entries, public.journal_lines, public.audit_log FROM PUBLIC;--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  IF current_user = 'purse_app' THEN
    RAISE EXCEPTION 'migrations must run as the owner role (purse_migrator), not as the runtime role';
  END IF;

  FOREACH t IN ARRAY ARRAY['tenants', 'accounts', 'journal_entries', 'journal_lines', 'audit_log'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t AND tableowner = current_user
    ) THEN
      RAISE EXCEPTION 'table public.% is not owned by % (run pnpm db:setup to reassign ownership)', t, current_user;
    END IF;
    IF NOT has_table_privilege('purse_app', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION 'purse_app did not receive SELECT on public.%', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines', 'audit_log'] LOOP
    IF has_table_privilege('purse_app', format('public.%I', t), 'UPDATE')
      OR has_table_privilege('purse_app', format('public.%I', t), 'DELETE')
      OR has_table_privilege('purse_app', format('public.%I', t), 'TRUNCATE') THEN
      RAISE EXCEPTION 'purse_app must not hold UPDATE, DELETE or TRUNCATE on public.%', t;
    END IF;
  END LOOP;
END $$;
