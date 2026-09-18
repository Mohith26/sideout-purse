# Sideout on Purse

Sideout is a charity beach volleyball tournament product. Purse is the competition
infrastructure it runs on: a ledger, contest and settlement engine, eligibility rules, an
embeddable SDK, and an operator console, built from scratch as a real platform with a
real boundary in front of it. The full design is in [`docs/system-spec.md`](docs/system-spec.md);
the decisions it leaves open are answered in [`docs/decisions.md`](docs/decisions.md).

This README covers the workspace layout and the quickstart, and carries the short version
of each write-up section as its phase lands (the ledger, how a score becomes a payout, the
rounding rule). The full write-up, with the consensus half, the provider seams and
screenshots, lands with the last phase.

## Layout

One pnpm workspace, two apps, and the packages that sit between them. Sideout may import
from Purse only through `@purse/sdk` and `@purse/types`; an ESLint rule enforces that in
CI, and a test proves the rule fires. The two apps have separate databases and separate
connection strings that are never loaded into the same process.

```
apps/
  purse/            Purse API. Hono on Node 22, Drizzle + postgres, Zod.   PURSE_DATABASE_URL (+ PURSE_MIGRATOR_DATABASE_URL)
  sideout/          Sideout web app. Next.js 15 App Router, Tailwind 4.   SIDEOUT_DATABASE_URL
  purse-embed/      (phase 4) the iframe-hosted identity and wallet flows
  purse-console/    (phase 5) the operator console
packages/
  ui/               @sideout/ui   design tokens, Tailwind theme, the AppShell primitive
  purse-types/      @purse/types  API error taxonomy, header names, the eligibility vocabulary and the v1 resource shapes
  purse-sdk/        @purse/sdk    the partner-facing client (phase 4 implements; phase 0 ships its version)
  ids/              @repo/ids     typed-prefix UUID v7 ids shared by both apps
  db/               @repo/db      connection and migration helpers; holds no schema, no URL
  logger/           @repo/logger  structured JSON log lines and build-sha resolution, shared by both apps
  config/           @repo/config  ESLint flat config (with the boundary rule) and tsconfig presets
docker/postgres/    init script for the compose Postgres: two databases, three roles
scripts/            db-setup: the same provisioning against any Postgres you can reach
docs/               system-spec.md (verbatim), decisions.md, providers.md (the provider seam table)
test/               repository-level tests: the boundary lint rule, env isolation
```

Each app owns its Drizzle config and migration folder (`apps/*/drizzle`). Migrations are
forward-only and applied by `pnpm db:migrate`, which runs each app's migrator in its own
process. Reference rows never live in migration history: `pnpm db:seed` upserts them in
both apps (in Purse, the Sideout tenant, its platform ledger accounts, and three seed
contests: a draft, an open one with entrants holding promo points, and a settled one whose
results reconcile; in Sideout, the demo events described under "Quickstart") and can be
re-run against any environment.

Purse connects as two roles. `purse_migrator` owns its databases and runs migrations and
seeds; `purse_app`, the API's runtime role, owns nothing and cannot `UPDATE` or `DELETE`
journal rows, which Postgres enforces rather than the code. See "How the ledger cannot
drift" below and [`docs/decisions.md`](docs/decisions.md).

## Quickstart

Requires Node 22.9 or later (`.nvmrc`), pnpm 11, and a Postgres 16 to talk to.

```sh
git clone <this repo> && cd sideout-purse
pnpm install

# Postgres, one of:
docker compose up -d        # provisions the roles and databases on first start; the
                            # .env.example defaults match it, so copy them into place:
cp apps/purse/.env.example apps/purse/.env && cp apps/sideout/.env.example apps/sideout/.env
pnpm db:setup               # or: provision an existing Postgres (defaults to localhost:5432 as you)
                            #     and write apps/purse/.env and apps/sideout/.env with local defaults

pnpm db:migrate             # applies both apps' migrations, each in its own process
pnpm db:seed                # Purse: the Sideout tenant, its platform accounts, the active ruleset, six users,
                            # two API keys and the seed contests. Sideout: the demo events. Both safe to re-run
pnpm dev                    # Purse on :4000, Sideout on :3000
```

The first seed prints nothing secret. To hold a key, ask for it:

```sh
pnpm --filter @purse/api db:seed -- --print-keys               # prints the plaintext of any key this run created
pnpm --filter @purse/api db:seed -- --print-keys --rotate-keys # revokes the seed keys and prints the new ones
```

Then:

```sh
curl localhost:4000/health   # { data: { sha, migrations, rulesetVersion, sdkVersion } }
curl localhost:3000/health   # { data: { sha, migrations, purseSdkVersion } }
curl localhost:3000/api/tournaments                              # the three seeded events
curl localhost:3000/api/tournaments/sandbar-classic-2026         # live: pools, standings, bracket, sponsors
curl localhost:3000/api/tournaments/sandbar-classic-2026/impact  # raised vs goal, from donation rows
open http://localhost:3000   # the Sideout shell
pnpm --filter @purse/api reconcile   # the seven ledger invariants against the dev database; exits 1 on any failure
```

`GET /internal/reconcile` returns the same report over HTTP behind `INTERNAL_API_TOKEN`
(`Authorization: Bearer ...`); with no token configured it is closed outside tests.

`pnpm db:seed` gives Sideout a charity, two organizers, 48 players, three sponsors and one
tournament in each of `registration_open`, `live` (24 teams, six pools played out, a
16-bracket with one bye and the quarterfinals in progress) and `settled`. The pools and
brackets are produced by the same draw engine the organizer endpoint uses and every set is
checked by the scoreline rules, so nothing on screen is typed. Re-running the seed is a
no-op; `SEED_ANCHOR=<iso>` pins the live event's start.

## Sideout API (phase 6)

Every response is `{ data }` or `{ error: { type, code, message, detail? } }`; cents are
decimal strings. Public reads omit every Purse identifier and never show a draft.

```
GET   /api/tournaments[?status=]              GET  /api/tournaments/:slug (pools, bracket, standings, sponsors)
GET   /api/tournaments/:slug/standings         GET  /api/tournaments/:slug/impact
GET   /api/matches/:id                         GET  /api/me                          (session)
POST  /api/auth/request-code  /api/auth/verify  /api/auth/logout
POST  /api/teams (invite partner by phone)     POST /api/teams/:id/join              (session)
POST  /api/tournaments/:slug/register          (session, captain; takes the entry donation)
POST  /api/admin/tournaments                   PATCH /api/admin/tournaments/:id       (organizer; fields + status)
POST  /api/admin/tournaments/:id/draw[?preview=1]   POST /api/admin/matches/:id/forfeit
POST  /api/webhooks/stripe                     POST /api/dev/login                   (outside production only)
```

Sideout's environment, beyond the database URLs (`apps/sideout/.env.example`):
`SESSION_SECRET` (32+ chars, required in production), `SMS_PROVIDER=log` (outside production
only; production without a provider refuses sign-in), `TRUSTED_PROXY_HOPS` (Railway: 1),
`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (together or not at all; unset outside
production selects the dev donation provider, unset in production refuses registration), and
`RESERVATION_TTL_MINUTES` (default 30: how long a registration whose donation is still
pending holds its place), and `AUTH_CODE_GLOBAL_CAP` (default 600: sign-in codes one instance
sends per ten minutes, the SMS budget). The SMS provider and the Stripe account are the
captain's calls before public deploy ([`docs/decisions.md`](docs/decisions.md)).

Send `X-Request-Id: anything-you-like` to either and it comes back on the response and in
that service's JSON log line, which is how a Sideout request will be traced into the Purse
calls it makes.

`pnpm db:setup` takes `--admin-url` (or `DATABASE_ADMIN_URL`) for a Postgres that is not
the local default; `apps/*/.env.example` list every variable with a comment, and
`apps/purse/src/env.ts` is the authoritative list for Purse.

## The API

Purse's public API is `/v1` (spec 4.7): the secret key in `Authorization: Bearer sk_...`,
`Idempotency-Key` on every mutation, `{ data }` or
`{ error: { type, code, message, detail? } }` with the sealed error types
(`invalid_request`, `authentication_error`, `permission_error`, `not_eligible`,
`insufficient_funds`, `invalid_state`, `conflict`, `rate_limited`, `internal_error`).
Amounts are decimal strings of minor units. A replay of a key returns the stored response
and creates nothing (`Idempotent-Replayed: true`); the same key with a different request
is a `conflict`.

```sh
KEY=sk_sandbox_...   # from db:seed --print-keys
curl -s localhost:4000/v1/users -H "Authorization: Bearer $KEY" -H "Idempotency-Key: u1" \
  -H "content-type: application/json" \
  -d '{"externalId":"sideout:ana","displayName":"Ana Reyes","dateOfBirth":"1994-03-12","location":{"declaredRegion":"US-TX"}}'
```

The routes: `POST /users` (create or upsert by `externalId`), `GET /users/:id`,
`POST /users/:id/verification` (starts the identity flow through the provider seam and
returns a five-minute, single-use embed token), `GET /users/:id/wallet`,
`POST /users/:id/credits` (operator-scoped keys only); `POST /contests`,
`GET /contests/:id`, `POST /contests/:id/{open,lock,start,finish,cancel}`,
`POST /contests/:id/entries` (evaluates eligibility, escrows the entry),
`DELETE /contests/:id/entries/:userId`, `POST /contests/:id/scores`,
`GET /contests/:id/preview` (the frozen settlement preview with its payout hash),
`POST /contests/:id/close` (requires that hash), `POST /contests/:id/void`,
`GET /contests/:id/results`; `POST /embed/tokens`; `GET /internal/reconcile` and
`GET /health` (also at the root). Every endpoint and every error type is recorded in
`apps/purse/test/contract/fixtures.json`.

Eligibility (spec 4.5) is a pure evaluator over a versioned, stored ruleset; the seeded
version is the spec's own example, in which `POINTS` is permitted everywhere with no
verification and `CREDIT` is region-gated, verification-gated and stake-limited. Every
entry attempt leaves a decision row carrying the ruleset version. Identity, geolocation
and risk are provider seams with deterministic dev implementations:
[`docs/providers.md`](docs/providers.md) names the vendor each stands in for.

## How a score becomes a payout

The consensus half (two teams agreeing on a scoreline) is Sideout's and lands in phase 7.
The Purse half is in place: a contest moves through spec 4.3's lifecycle
(`draft -> open -> locked -> in_progress -> awaiting_settlement -> settling -> settled`,
with `cancelled` for a contest holding nothing and `voided` for one whose entries are all
refunded) through one `transition()` function (`apps/purse/src/contests/transition.ts`)
that takes `SELECT ... FOR UPDATE` on the contest row, validates the move against a table
the database also enforces, and writes `audit_log` with the row before and after. Nothing
else assigns `contests.state`.

Entering a contest escrows the entry amount in the same transaction as the participant
row (`debit user_wallet / credit contest_escrow`); withdrawing before lock refunds it.
Scores are append-only rows with a `superseded_by` chain; a finished attempt is final.
When every entered participant has a finished score the contest moves to
`awaiting_settlement` on its own, and a contest with `settlement_policy = auto` settles
there and then. Every Sideout tournament ships on `operator_close`: a human fetches the
preview, which is computed by the settlement engine and hashed, and closes with that hash.
The close recomputes under the row lock; if anything changed since the preview the hashes
differ and the close is refused before a unit moves. What lands is one journal entry:

```
Settle a contest (one entry, many lines, must balance)
  debit  contest_escrow:cnt_y    400 POINTS
  credit user_wallet:usr_a       200 POINTS   1st
  credit user_wallet:usr_b       100 POINTS   =2nd
  credit user_wallet:usr_c       100 POINTS   =2nd
```

plus one `contest_results` row per entrant (placement, score, payout, the entry that paid
it), written once. Twenty-five simultaneous closes produce exactly one of those; the rest
find the contest settled (`apps/purse/test/contests/concurrency.test.ts`).

## The rounding rule

The settlement engine (`apps/purse/src/settlement/`) is a pure function: no database, no
clock, no randomness, and the same input gives the same output byte for byte whatever
order the entrants arrive in. Every share is computed with floor division in `bigint`, and
whatever the floors leave over is handed out one minor unit at a time to the best
placement first, then the next, and so on; within a tie group, by ascending `userId`.
Nothing is ever lost. 100 points split three ways is **34 / 33 / 33**, never 33 / 33 / 33
with a unit missing; `[50, 30, 20]` of 101 points is **51 / 30 / 20**. Conservation
(`sum(payout) === escrowTotal`, exactly), non-negativity, placement monotonicity and
determinism under permutation are `fast-check` properties over thousands of generated
contests (`apps/purse/test/settlement/settle.test.ts`), not examples. The full rule set,
including how each prize structure and tie-break rule behaves, is in
`apps/purse/src/settlement/README.md`.

## How the ledger cannot drift

The short version, until the full write-up lands with the last phase. Purse's ledger
(`apps/purse/src/ledger/`) is an immutable double-entry journal: every entry has at least
two lines, balances per asset inside the transaction that writes it (checked by the service
before it writes and by a deferred constraint trigger at commit, so a writer that bypasses
the service is held to the same rules), and is never updated or deleted. That last part is
a property of the database role the API runs as, not a convention in the code: `purse_app`
holds `SELECT` and `INSERT` on the journal and nothing else, and a test expects the
`UPDATE` to fail. Mistakes are corrected by posting a reversing entry. Balances are derived
by summing lines, so any balance at any past moment is one `WHERE posted_at <= $1` away.

`reconcile()` (`apps/purse/src/ledger/reconcile.ts`) checks the seven invariants from
spec 4.2.4 (the journal nets to zero per asset, every entry balances, no wallet is
negative, settled and voided escrows are empty, a settled contest's results sum to what it
escrowed, snapshots equal derived balances, every contest entry links to a matching escrow
entry). It runs in CI against the seeded database and is exposed at
`GET /internal/reconcile`. The test worth reading is
`apps/purse/test/ledger/random-ops.test.ts`: ten thousand seeded random operations
(issue, escrow, refund, settle, void, replay, reversal, attempted overdraft, and the
contest operations: create, open, lock, start, enter, withdraw, score, close behind the
preview hash, void, cancel), many fired concurrently, checked against an independent
replay of every accepted line and every contest's escrow, and then `reconcile()` must come
back clean.

## Checks

```sh
pnpm typecheck   # tsc -b over every project reference
pnpm lint        # eslint, including the Sideout/Purse boundary rule and no-console / no-any / no-empty-catch
pnpm test        # vitest, one project per package; the app projects migrate their own *_test databases
pnpm build       # tsup for Purse, next build for Sideout
```

CI (`.github/workflows/ci.yml`) runs all four against a `postgres:16` service container,
then migrates and seeds Purse's database and runs `reconcile` against it; a failing
invariant fails the build.
