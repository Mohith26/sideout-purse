-- Privileges for the reconcile run record (spec section 10: the last reconcile result on
-- `/health`), following the phase 1 role model (docs/decisions.md, "Two Purse database
-- roles"). A run is a fact about the ledger at a moment: the runtime may add one and read
-- them, never rewrite or remove one, so a failed run stays on the record.

GRANT SELECT, INSERT ON TABLE public.reconcile_runs TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.reconcile_runs FROM PUBLIC;
