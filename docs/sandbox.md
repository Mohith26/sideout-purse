# Self-serve sandbox

Open Purse's public `/docs` page, mint a pair of sandbox keys, then select and run a
contract example. Requests stay on that API's origin. The page displays the raw request
and response, creates a fresh idempotency key for each attempt, and keeps credentials
only in memory. Reloading loses them. A successful response supplies ids and tokens for
newly selected examples; the path and JSON remain editable. Secrets on this page are
throwaway sandbox credentials. Managed integrations keep secret keys on their servers.

A sandbox is a fresh tenant, not access to Sideout's seeded demo. Its secret key carries
operator scope within that tenant, so a visitor can issue test POINTS or CREDIT and
exercise settlement. The publishable key is for iframe/browser flows. There is no real
money or licensed identity verification. Licensing and real KYC are deliberately out of
scope; this is an architecture exercise, not a licensed operator. The exact provider
seam table from `docs/providers.md` appears on the docs page.

Outbound webhooks are unavailable for self-serve tenants. All webhook mutations return
`403 permission_error / sandbox_webhooks_unavailable`; reads remain available. Managed
tenants retain their existing behavior. Every webhook destination, on every tenant, is now
validated and pinned (`docs/webhooks-security.md`), so this refusal no longer stands in for
a missing check: it stays because an anonymous visitor who could register an endpoint could
still make the deployment emit signed POSTs to arbitrary public hosts, and the `/docs`
sandbox runs its examples in the visitor's own browser with no receiver to point at
(`docs/decisions.md`, "Webhook destination validation"). The internal reconciliation
endpoint requires a host token and is not unlocked by a sandbox key. Embed calls require
their normal session/token handshake.

## Minting and limits

`POST /v1/sandbox/keys` is public and accepts `{}` and an `Idempotency-Key`. Its response
is `{ data: { tenantId, secretKey, publishableKey, expiresAt, replayed } }`. The first
response returns the plaintext keys once. Retrying the same key from the same address
returns the same tenant with null keys and `replayed: true`. No plaintext key is stored
in a replay receipt, database or application log; keys use the existing argon2id hashes.
The immutable receipt retains the request key, originating address, origin and expiry.
A changed origin under the same request key conflicts. Minting accepts no custom tenant,
scope, lifetime or origin input. A foreign browser Origin is refused.

Both keys expire after 24 hours. The immutable tenant lease also expires, so issuing
another key through the operator console cannot extend a self-serve sandbox. Expiry is
checked on every authentication, including cached key verification and publishable-key
requests. Ordinary key revocation takes effect immediately.

- At most three unexpired leases per address, enforced under a database advisory lock.
  Revoking a key does not free that address's quota before the lease expires.
- Mint requests, including retries and invalid requests, have an address token bucket:
  burst three, refill one per hour; and a process bucket: burst ten, refill one per minute.
- Minting and ordinary API limits reuse `src/http/rate-limit.ts`. A token bucket refusal
  returns `429` with `Retry-After`; the persistent cap returns `429 sandbox_limit`.
- Ordinary API calls use `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SECOND`. In-memory buckets
  are per process; the three-live-lease bound survives restarts and multiple replicas.
- Configure `TRUSTED_PROXY_HOPS` correctly: zero locally, one behind the hosted load
  balancer. This controls the address recorded and limited; no arbitrary forwarded host
  is trusted. A trusted proxy's forwarded protocol allows HTTPS termination.

## Retirement

Run the existing owner-role command `pnpm --filter @purse/api db:purge` on the host's
maintenance schedule. It retires expired self-serve tenants, revokes their keys and
origins, disables any webhook endpoints provisioned by an operator, and appends an audit
record in the same transaction. Repeating the purge is safe. Managed/demo tenants have
no lease and are never selected by this path. Retired tenants cannot be reinstated.

This is retirement, not physical deletion: tenant data, lease receipts (including the
minting address), journal entries and audit history are retained. The runtime receives
no DELETE privilege on append-only tables. Existing retention of old idempotency records,
embed tokens, sign-in codes and operator sessions is unchanged. Expired credentials stop
working even if no purge job has run; retirement does not depend on an API process timer.

The public demo also runs its existing nightly demo reset. That reset clears sandbox
users, contests and ledger data along with other demo data; keys, origins and immutable
lease receipts survive, so neither expiry nor minting quotas reset. The 24-hour lifetime
is a credential lifetime, not a promise that demo data survives the nightly reset.

## Host switch

`SANDBOX_SELF_SERVE` accepts `true` or `false`. It defaults to `true` outside production
and `false` in production. For the public demo, set **`SANDBOX_SELF_SERVE=true` on the
Purse Railway service**. To disable minting, set it to `false` and restart the API. The
public `/docs` page remains available with minting disabled. Existing keys retain their
original 24-hour expiry; the switch controls new minting. `/health` and `/v1/health`
report `sandboxSelfServe`. No new service or required variable is needed.

The docs HTML is rendered by `src/routes/docs.ts`; its request/response examples import
`test/contract/fixtures.json` and are bundled into the service. The coverage test checks
every registered v1 endpoint against these fixtures, and pins the provider seam table to
`docs/providers.md`. After an intentional contract change, regenerate fixtures with
`UPDATE_CONTRACT_FIXTURES=1 pnpm --filter @purse/api test test/contract`.
