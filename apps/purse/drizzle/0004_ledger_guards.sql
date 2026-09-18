-- Two guards the database holds regardless of who is writing (docs/decisions.md,
-- "The database checks every entry at commit" and "Column-level UPDATE on accounts").
--
-- 1. A deferred constraint trigger on journal_lines. Spec 4.2.2 rules 1 to 3 are checked
--    by postEntry before it writes; this checks them again inside the writing transaction,
--    at commit, for every entry the transaction touched. A caller that bypasses the
--    service (the owner role, a hand-written script, a future bug) still cannot commit an
--    entry with fewer than two lines, more than one asset, or debits that differ from
--    credits.
--
-- 2. The runtime role loses table-level UPDATE on accounts and tenants. A derived balance
--    depends on an account's kind, normal_side, tenant_id, owner_ref and asset; a runtime
--    that could rewrite those could change history without touching the journal. The only
--    runtime update is to status (freezing or closing), so that column and updated_at are
--    all it may change. Postgres checks FOR UPDATE row locks against column privileges,
--    so postEntry's locks still work.

CREATE FUNCTION public.assert_journal_entry_balanced(entry text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  line_count bigint;
  asset_count bigint;
  net numeric;
BEGIN
  SELECT count(*),
         count(DISTINCT asset),
         coalesce(sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0)
    INTO line_count, asset_count, net
    FROM public.journal_lines
   WHERE entry_id = entry;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); an entry needs at least two', entry, line_count
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_balanced', TABLE = 'journal_lines';
  END IF;
  IF asset_count <> 1 THEN
    RAISE EXCEPTION 'journal entry % carries % assets; all lines must share one', entry, asset_count
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_balanced', TABLE = 'journal_lines';
  END IF;
  IF net <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance; debits minus credits is %', entry, net
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_balanced', TABLE = 'journal_lines';
  END IF;
END $$;--> statement-breakpoint

CREATE FUNCTION public.journal_lines_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.entry_id <> NEW.entry_id THEN
    PERFORM public.assert_journal_entry_balanced(OLD.entry_id);
  END IF;
  PERFORM public.assert_journal_entry_balanced(NEW.entry_id);
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_lines_entry_balanced
  AFTER INSERT OR UPDATE ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.journal_lines_entry_balanced();--> statement-breakpoint

-- Revoking the table-level privilege also drops any column-level UPDATE, so the column
-- grants come after it.
REVOKE UPDATE ON TABLE public.accounts, public.tenants FROM purse_app;--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON TABLE public.accounts TO purse_app;--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON TABLE public.tenants TO purse_app;--> statement-breakpoint

DO $$
DECLARE
  t text;
  c text;
BEGIN
  IF current_user = 'purse_app' THEN
    RAISE EXCEPTION 'migrations must run as the owner role (purse_migrator), not as the runtime role';
  END IF;

  FOREACH t IN ARRAY ARRAY['accounts', 'tenants'] LOOP
    IF has_table_privilege('purse_app', format('public.%I', t), 'UPDATE') THEN
      RAISE EXCEPTION 'purse_app must not hold table-level UPDATE on public.%', t;
    END IF;
    FOREACH c IN ARRAY ARRAY['status', 'updated_at'] LOOP
      IF NOT has_column_privilege('purse_app', format('public.%I', t), c, 'UPDATE') THEN
        RAISE EXCEPTION 'purse_app did not receive UPDATE on public.%.%', t, c;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.journal_lines'::regclass
      AND tgname = 'journal_lines_entry_balanced'
      AND tgdeferrable AND tginitdeferred AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'journal_lines_entry_balanced is missing, not deferred, or disabled';
  END IF;
END $$;
