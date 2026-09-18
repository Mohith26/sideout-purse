# Project agent memory

Sideout (charity beach volleyball product) on Purse (the competition platform it runs on).
`docs/system-spec.md` is the acceptance contract: its MUST statements are load-bearing, its
DEFAULTs are taken unless `docs/decisions.md` records a reason. Section 9 of the spec is the
phase order; section 7 is the banned list (no `any`, no empty `catch`, no `console.log`
outside the logger, no floats in the money path, no gradients or emoji iconography).

## Working here

- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. `.no-mistakes.yaml` and
  `.github/workflows/ci.yml` run the same four; keep them in step.
- `apps/purse/src/env.ts` is the authoritative list of Purse's variables (`.env.example` is
  the template); the provider seams and the dev identity lists are explained in
  `docs/providers.md`, the rate limit is `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SECOND`, and
  `TRUSTED_PROXY_HOPS` (0 locally, 1 behind the hosted load balancer) picks the client
  address out of `X-Forwarded-For`.
- Local Postgres: `pnpm db:setup` (any reachable Postgres; writes `apps/*/.env`) or
  `docker compose up -d` plus `cp apps/<app>/.env.example apps/<app>/.env` for both apps (the
  examples match compose), then `pnpm db:migrate` and `pnpm db:seed`. Tests use the `*_test`
  databases, wipe them in each app's `test/global-setup.ts`, and need no `.env`: each app's
  `test/setup-env.ts` falls back to `db:setup`'s default URLs (CI's or a `.env`'s values
  win). A compose volume from before phase 1 lacks `purse_migrator`;
  `pnpm db:setup --admin-url ...` upgrades it in place.
- Four apps: `apps/purse` (the API, `@purse/api`), `apps/purse-embed` (the iframe flows,
  `@purse/embed`, a Next static export the API serves under `/embed`), `apps/purse-console`
  (the operator console, `@purse/console`, a server-rendered Next app on its own origin)
  and `apps/sideout`. `pnpm dev` starts Purse on :4000, the embed dev server on :4100
  (proxies `/v1` to :4000), the console on :4200 and Sideout on :3000; the API and Sideout
  expose `/health`. To have :4000 serve the embed like production,
  `pnpm --filter @purse/embed build` first (`PURSE_EMBED_DIR` overrides the directory;
  without a build `/embed` answers 404). Sideout's seeded events are under
  `/api/tournaments`; `POST /api/dev/login` with a seeded phone (`+14155550100` is an
  organizer) gives a session outside production. The console signs in as the seeded admin
  (`admin@purse.local`; `pnpm --filter @purse/api db:seed -- --print-operator-password
  --rotate-operator-password` prints a fresh password) and needs no `.env`
  (`PURSE_API_ORIGIN` defaults to :4000).
- `PURSE_SECRET_KEY` derives every process key (`apps/purse/src/secrets.ts`); production
  refuses to start without it, elsewhere a stand-in is used. `EMBED_SMS_PROVIDER`,
  `PURSE_EMBED_DIR`, `WEBHOOK_DISPATCHER` and `WEBHOOK_POLL_INTERVAL_MS` are the other
  phase 4 variables (`env.ts`); `PURSE_TENANT_ORIGINS` is read by the seed only.
- CI also migrates and seeds Purse's `purse` database, runs
  `pnpm --filter @purse/api reconcile` (a failing invariant fails the build) and, after the
  build, the console's Playwright smoke against that database.

## Purse roles and the ledger

- Two Purse roles (`docs/decisions.md`): `purse_migrator` owns the databases and runs
  `db:migrate`, `db:seed`, `db:setup` and the test reset (`PURSE_MIGRATOR_DATABASE_URL`);
  `purse_app` is the runtime (`PURSE_DATABASE_URL`), owns nothing, and holds only what
  `apps/purse/drizzle/0002_ledger_roles.sql`, `0004_ledger_guards.sql`,
  `0006_contest_guards.sql`, `0008_identity_guards.sql` and
  `0010_idempotency_reservation_grants.sql` grant. Every new table needs an explicit
  `GRANT ... TO purse_app` in a custom migration (`db:generate:custom`); an append-only
  table (journal, audit log, `contest_results`, `idempotency_keys`) gets `SELECT, INSERT`
  only, and a table with columns that legitimately change gets column-level `UPDATE`
  (`accounts`, `tenants`: `status, updated_at`; `contests`: `state`, `settled_at`,
  `locks_at` and the draft-editable fields; `contest_participants`: `state`, and
  `entry_journal_entry_id`, `team_ref`, `seed` only when a withdrawn entrant re-enters;
  `contest_scores`: `superseded_by`; `idempotency_reservations`: everything but the key;
  the phase 3 tables per the header of `drizzle/0008_identity_guards.sql`; the phase 4
  tables per `0012_embed_webhook_guards.sql`, `webhook_delivery_attempts` append-only).
  `test/ledger/roles.test.ts` fails on a table with
  no grant and pins the updatable columns of every contest and identity table. A wallet
  needs a `users` row (`accounts.user_id` is a foreign key), so test fixtures create users
  before wallets (`createUser`, `openWallet`, `buildArena`). Tests take the runtime
  connection from `test/helpers.ts` (`connectRuntime`) and the owner connection only for
  fixtures and teardown (`connectMigrator`). The API refuses to boot on a role that can
  `UPDATE` any append-only table (`src/ledger/role-check.ts`).
- The ledger lives in `apps/purse/src/ledger/`. `postEntry` is the only way value moves
  (rules 1-7 of spec 4.2.2, the wallet and escrow non-negative guard, sorted `FOR UPDATE`
  locks, idempotent replay by (tenant, key) with a request-hash conflict check); the 4.2.5
  flows are typed wrappers in `flows.ts`; corrections are `reverseEntry`, never an update,
  and take the acting tenant. Pass a transaction to post atomically with your own writes.
  A deferred constraint trigger (`journal_lines_entry_balanced`) re-checks rules 1-3 at
  commit for any writer; a test that needs to commit a broken entry as the owner disables
  it for that one transaction (see `test/ledger/reconcile.test.ts`). `reconcile()`
  (`reconcile.ts`) is the registry of all seven invariants.
- Money is `bigint` end to end; raw SQL sums are cast `::text` and parsed with `BigInt`.
- The randomized ledger test (`apps/purse/test/ledger/random-ops.test.ts`) runs 10,000
  operations (ledger and contest operations mixed) by default and refuses fewer under `CI`.
  Locally: `LEDGER_RANDOM_OPS=500 LEDGER_RANDOM_SEED=1 pnpm --filter @purse/api test test/ledger/random-ops`.

## Contests and settlement

- `apps/purse/src/contests/transition.ts` is the only writer of `contests.state`; the
  state table is `states.ts` and the database holds the same table in the
  `contests_state_machine` trigger (`drizzle/0006_contest_guards.sql`), so change both
  together. `settling` is entered and left inside `executeSettlement`'s transaction under
  the contest row lock (`lockContest`, `SELECT ... FOR UPDATE`), which every contest write
  starts with. Account row locks come after it, sorted by id, in one statement per
  operation (`voidContest` locks every wallet it will refund up front for that reason).
- `apps/purse/src/settlement/` is pure: no database, clock or randomness may be imported
  there, and `previewSettlement` and `closeContest` must keep calling the same `settle` and
  `payoutHash`. The rounding rule and each structure's meaning are documented in
  `settle.ts` and `settlement/README.md`; `docs/decisions.md` (phase 2) records the rules
  the spec left open (expected results, finished attempts, the hash's canonical form).
- Every contest mutation takes an `idempotencyKey` and goes through `idempotent()`
  (`contests/idempotency.ts`, backed by `idempotency_keys`); money moves only through the
  ledger's typed flows inside the same transaction. New mutations follow the same shape:
  lock the contest first, post through `postEntry`'s helpers, record with `idempotent`.
- `contests/eligibility.ts` is where an entry meets the eligibility engine: `enterContest`
  records a request's `location` first (its own transaction, kept on refusal), evaluates
  under the contest lock plus a per-user advisory lock, records one `eligibility_decisions`
  row per attempt (a refusal's after its transaction rolled back), and refuses with
  `not_eligible`, or `insufficient_funds` when a shortfall is the only reason.

## Embed, SDK and webhooks

- The iframe protocol is `packages/purse-types/src/protocol.ts` (zod/mini, `v: 1`,
  `parseMessage`); the SDK (`packages/purse-sdk/src/purse.ts`, `Purse.post` is the only
  `postMessage`, never `'*'`) and the frame (`apps/purse-embed/src/embed/bridge.ts`,
  `receiver.ts`) both import it. `pnpm --filter @purse/sdk build` makes the partner bundle
  (`@purse/sdk/bundle`); `verifyWebhook` / `signWebhook` in `src/webhooks.ts` are the one
  signature implementation, used by the dispatcher and by receivers.
- The embed's browser API is `apps/purse/src/routes/embed.ts` (`/v1/embed/*`, publishable key
  plus the `purse_session` cookie from `src/embed/session.ts`; middleware per route so
  `POST /v1/embed/tokens` stays on the secret-key stack); the allowlist is `tenant_origins`
  (`src/embed/origins.ts`, also CORS and `frame-ancestors`); sign-in is `src/embed/signin.ts`
  behind the `SmsSender` seam (`src/embed/sms.ts`). Rate limiting there is by address.
- Webhooks live in `apps/purse/src/webhooks/`: `emitEvent` writes `webhook_deliveries` in the
  caller's transaction (emit sites: `contests/transition.ts`, `contests/entries.ts`,
  `users/verification.ts`, `ledger/post.ts`); `WebhookDispatcher` leases and posts;
  `schedule.ts` is the eight-attempt table; secrets rest as AES-GCM envelopes
  (`endpoints.ts`, `src/secrets.ts`). A new event type is a `@purse/types` change, the CHECK
  literal in `schema.ts` and a migration. `test/webhooks/dispatcher.test.ts` is the
  receiver-down demo with a fake clock; `test/webhooks/receiver.ts` is the sample receiver.

## Operator console

- `apps/purse/src/routes/console/` is the console's API, mounted at `/console` behind the
  operator session (`Authorization: Bearer cst_...`, `src/operators/`: argon2id passwords,
  stateful `operator_sessions`, `requireAdmin()` for tenant status, keys and rulesets).
  `index.ts` has the stack; every mutation under `/tenants/:tenantId/*` takes an
  `Idempotency-Key` (the generalised `http/idempotency.ts`, `console:` prefix); the rest is
  idempotent at the service level. Reads are `ledger/explorer.ts` (tree, as-of balance,
  running balances, entry detail), `contests/browse.ts`, `users/search.ts`,
  `eligibility/flags.ts` (review), `tenants/`. `test/console/` drives every endpoint.
- `apps/purse-console` renders pages with `src/server/api.ts` (`load`, 401 → `/login?next=`),
  mutates through its `/api/purse/[...path]` proxy (`src/lib/client.ts` mints one
  idempotency key per action) and holds the token only in the `purse_console_session`
  cookie; the middleware gates pages with no cookie. Screens are server components under
  `src/app/(console)/`, the interactive parts client components in `src/components/`
  (`CloseFlow`, `InvariantPanel`, `RulesetTester`, `DeliveryTable`, `FlagQueue`).
  `pnpm --filter @purse/console build` fails if `.next/static` carries `sk_`, `whsec_` or a
  session token (`scripts/check-bundle.ts`); `pnpm --filter @purse/console e2e` is the
  Playwright smoke (seeds an `e2e-admin@purse.local`, needs a built console and the dev
  `purse` database migrated and seeded). The dense primitives (`Button`, `Chip`,
  `DataTable`, `KeyValue`, `Money`, ...) are `@sideout/ui`, `so-*` classes in `components.css`.

## Identity, eligibility and the v1 API

- `apps/purse/src/eligibility/`: `evaluate.ts` is pure (no database, clock or randomness;
  `asOf` is an input) over a `Ruleset` from `ruleset.ts` (Zod; `SPEC_EXAMPLE_RULESET` is the
  seeded active version). `rulesets.ts` stores versions (body immutable, one active),
  `velocity.ts` sums the journal, `decide.ts` gathers the input and persists the decision,
  `collusion.ts` is the head-to-head signal. `test/eligibility/evaluate.test.ts` is the case
  table; a new reason or action is a `@purse/types` change first.
- `apps/purse/src/users/`: users (upsert by `external_id`), the verification machine
  (`verification.ts`, provider called between two transactions), restrictions (a user can
  never lift one), locations, and the duplicate-identity fingerprint. Every write audits.
- `apps/purse/src/providers/`: the three seams and their `dev` implementations, selected
  by `IDENTITY_PROVIDER` / `GEO_PROVIDER` / `RISK_PROVIDER` (`env.ts` owns the sealed list);
  production refuses `dev` without `ALLOW_DEV_PROVIDERS=true`. `docs/providers.md` is the
  seam table.
- `apps/purse/src/auth/`: API keys (argon2id hash only, lookup by prefix, `scopes` holds the
  `operator` flag) and embed tokens (SHA-256, single use, five minutes).
- `apps/purse/src/http/` is the v1 middleware, outermost first: `rate-limit.ts`
  (`limitAuthFailures` charges an address only for a failed authentication and never
  refuses a request that authenticates; `rateLimit` per key id after `auth.ts`; in memory,
  never keyed by a key's prefix), `auth.ts` (bearer secret key; `requireOperator()`),
  `body.ts` (JSON read once with a streamed size cap, `parseBody` with Zod),
  `idempotency.ts` (claims the key in `idempotency_reservations`, runs the handler on the
  pool as `c.get('db')` so no transaction or lock spans a provider call, then stores the
  response under the `http` scope of `idempotency_keys`), and `errors.ts` (`toApiError`
  maps every domain error by shape; throw `RequestValidationError`, never a Zod 4
  `ZodError`, which is not an `Error`). Routes live in `routes/v1/`
  (`users.ts`, `contests.ts`, `embed.ts`, `serialize.ts` for wire shapes, `schemas.ts` for
  money and ids); `/health` and `/internal/reconcile` are mounted at the root and under
  `/v1` outside that stack. Response shapes are the `@purse/types` resources.
- Contract: `test/contract/contract.test.ts` drives every endpoint and error type and
  compares with `test/contract/fixtures.json`; after a deliberate contract change rerun it
  with `UPDATE_CONTRACT_FIXTURES=1` and commit the file.
- A sandbox key locally: `pnpm --filter @purse/api db:seed -- --print-keys` prints the seed
  keys' plaintext the one time they are created; `-- --print-keys --rotate-keys` revokes
  and reissues them. Then `curl -H "Authorization: Bearer sk_sandbox_..." -H
  "Idempotency-Key: k1" -H "content-type: application/json" -d '{"externalId":"u1"}'
  localhost:4000/v1/users`.
- Retention runs as the owner: `pnpm --filter @purse/api db:purge` (idempotency keys and
  their claims past 30 days, stale embed tokens).

## The boundary, and where things go

- Sideout imports from Purse only through `@purse/sdk` and `@purse/types`; Purse imports
  nothing from Sideout; the embed and console apps import nothing of the API's source (they
  speak HTTP) and, alone among Purse's apps, may use `@sideout/ui`.
  `packages/config/eslint/boundary.js` enforces it and `test/boundary.test.ts` proves it.
  Neutral shared code lives in `@repo/*`.
- Each app names only its own connection string (`apps/*/src/env.ts`);
  `test/env-isolation.test.ts` proves each `loadEnv` ignores the other's. Never add a root `.env`.
- Schema changes: edit `apps/<app>/src/db/schema.ts`, then `pnpm --filter <pkg> db:generate`
  (`db:generate:custom` for data migrations). Migrations are forward-only; never edit an
  applied one, and never put rows in one: reference data goes through the idempotent
  `db:seed` script. Follow the conventions in each schema file's header (typed-prefix ids
  with a CHECK via `idCheck`, `timestamptz`, `bigint` minor units with an explicit `asset`).
- New id prefixes go in `packages/ids/src/index.ts`, nowhere else.
- Tokens live only in `packages/ui/src/styles/tokens.css`; the Tailwind mapping is
  `theme.css`, primitives are plain CSS in `components.css`. The contrast test parses
  `tokens.css`, so a colour change that fails AA fails the build.

## Sideout conventions (apps/sideout)

- Layers: `src/domain/*` is pure (inject `Rng` and clocks; no db, no network); `src/server/*`
  owns transactions, audit rows and domain calls; `src/app/api/**/route.ts` only parses
  (Zod), calls a service and renders the `{ data } | { error }` envelope through
  `server/http/respond.ts`. Throw `failure.<type>(code, message)` from services; never build
  a response there. Cents are `bigint` in the server and decimal strings on the wire.
- Status changes go through `transitionTournament` / `forfeitMatch` (validated by
  `domain/state.ts`) and write `audit_log` in the same transaction. `final` and `disputed`
  are written only by the consensus (`server/consensus.ts`, system actor); no route sets them.
- Consensus (spec 5.2): `domain/consensus.ts` is the pure machine (transition table,
  canonical form and hash via `scoreline-hash.ts`, `judgeSubmission`, the
  `assertMayPushToPurse` gate); `server/consensus.ts` owns the two writers
  (`submitScoreline`, `resolveDispute`), both taking the tournament lock then the match lock,
  resolving the submitter's team from `team_members`, and entering `agreed` through one
  `enterAgreed` (sets written, key minted once, match `final`, winner advanced).
  `score_submissions` rows are never updated, only superseded.
- Purse, server side, lives in `src/purse/` (the one `PurseClient`; every call recorded in
  `purse_calls` through `databaseCallRecorder`, bodies redacted, 429s retried) and
  `src/server/purse/` (`contests.ts` mirrors the tournament and reads entrants back,
  `scores.ts` pushes agreed matches and the final standings, `close.ts` is the two-step
  close, `webhooks.ts` the receiver, `users.ts` the link and embed tokens). Keys: the
  consensus key for a match's scores, `<purse_external_id>:<step>` for contest steps,
  `<external id>:close:<hash>:<previewed at>` for the close. A route mirrors Purse only
  after its own transaction commits (`after-commit.ts`, the admin PATCH), never fatally.
  `docs/decisions.md` (phase 7) records what a score means, the `confirmed` rule and the
  prize mapping. The client never reaches a browser: `test/purse/bundle.test.ts` checks the
  client components and `scripts/check-bundle.ts` greps `.next/static` as part of `pnpm build`.
- Purse variables (`src/env.ts`): `PURSE_API_URL`, `PURSE_SECRET_KEY`, `PURSE_WEBHOOK_SECRET`
  on the server; `NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PURSE_ORIGIN`,
  `NEXT_PUBLIC_PURSE_TENANT_ID` for the SDK; all required in production, and outside it a
  missing secret key means the Purse routes answer 503 `purse_unavailable`. An exported but
  empty variable counts as unset.
- Who holds a place is `server/field.ts` (confirmed vs. an unlapsed reservation, judged
  against a `ReservationClock`); capacity, public team lists, the live guard and the draw
  go through it rather than filtering `teams.status` by hand.
- Session: signed HttpOnly SameSite=Lax cookie (`server/auth/session.ts`); `requireUser` /
  `requireOrganizer` in handlers. `/api/admin/*` is organizer-only. `/api/dev/login` exists
  only outside production (`route.dev.ts` + `pageExtensions`).
- Seams: `SmsSender` (`server/auth/sms.ts`) and `DonationProvider`
  (`server/donations/provider.ts`); `env.ts` selects the implementation and refuses
  `log`/`dev` in production. Donations never touch anything Purse-shaped; public responses go
  through `server/public-shape.ts`, which lists fields by hand and omits every `purse_*`.
- Seed: `src/db/seed/build.ts` is pure and uses the draw engine and scoreline rules, and
  gives every played match its consensus rows; `write.ts` upserts by id, leaving the Purse
  columns and a consensus's push state alone. `pnpm db:seed` at the root seeds both apps.
  With `PURSE_SECRET_KEY` set and the Purse API answering `PURSE_API_URL`, Sideout's seed
  then mirrors the seeded events to Purse through the app's services (`src/db/seed/purse.ts`:
  links, entries, pushes, the settled event closed); otherwise it logs that the walk was
  skipped and `purse_contest_id` stays null. Rerunning replays under the same keys.
- Route tests call handlers directly with `Request` objects (`test/helpers.ts`), truncate
  the test database per file, and override seams with `resetAppContext({...})`; Purse is
  `test/purse/fake-purse.ts` behind `resetAppContext({ purse: new PurseClient({ fetch }) })`.
  Shared fixtures are `test/api/fixtures.ts` (never import another test file).
- Both apps together for the integration walk (`test/integration/purse-walk.test.ts`, skipped
  unless configured): migrate and seed a Purse database
  (`pnpm --filter @purse/api db:seed -- --print-keys` prints the sandbox keys once), start
  the API (`pnpm --filter @purse/api dev`, or `tsx src/index.ts` with `PORT`), then
  `PURSE_INTEGRATION_API_URL=http://localhost:4000 PURSE_INTEGRATION_SECRET_KEY=sk_sandbox_...
  pnpm --filter @sideout/web test test/integration`. The gating variables are named apart from
  `PURSE_*` so the rest of the suite keeps to the in-memory Purse. CI does exactly this
  (`.github/workflows/ci.yml`), then seeds Sideout against the same Purse and reconciles.

## Sharp edges

- tsconfig `extends` must be relative paths (not `@repo/config/...`): Vite and the import
  resolver do not realpath pnpm symlinks before resolving a preset's own `extends`.
- Referenced packages emit declarations to `dist/` (gitignored) because `tsc -b` refuses
  `noEmit` on a referenced project; runtime consumers still read `src/` via `exports`.
- Next's `env` config only inlines static `process.env.X` reads; Sideout resolves
  `BUILD_SHA` at runtime in `apps/sideout/src/build-info.ts` (via `@repo/logger`'s
  `resolveBuildSha`) instead.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
