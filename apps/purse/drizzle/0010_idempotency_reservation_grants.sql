-- Privileges for the v1 idempotency middleware's claim table (src/http/idempotency.ts),
-- following the role model of 0002, 0006 and 0008:
--
--   idempotency_reservations  SELECT, INSERT; UPDATE on operation, request_hash,
--                             reserved_at and expires_at: a retry re-claims an expired row
--                             in place, and a 5xx expires the claim it held. Never the key
--                             or the tenant. DELETE stays with the owner (the purge).
--   idempotency_keys          unchanged: SELECT, INSERT. A stored response is history.

GRANT SELECT, INSERT ON TABLE public.idempotency_reservations TO purse_app;--> statement-breakpoint
GRANT UPDATE (operation, request_hash, reserved_at, expires_at) ON TABLE public.idempotency_reservations TO purse_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.idempotency_reservations FROM PUBLIC;
