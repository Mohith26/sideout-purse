# Sideout on Purse

Sideout is a charity beach volleyball tournament product. Purse is the competition
infrastructure it runs on: a ledger, contest and settlement engine, eligibility rules, an
embeddable SDK, and an operator console, built from scratch as a real platform with a
real boundary in front of it. The full design is in [`docs/system-spec.md`](docs/system-spec.md);
the decisions it leaves open are answered in [`docs/decisions.md`](docs/decisions.md).

This README covers the workspace layout and the quickstart. The full write-up (the ledger,
how a score becomes a payout, the rounding rule, the provider seams, screenshots) lands
with the last phase.

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
  purse-types/      @purse/types  API error taxonomy and header names
  purse-sdk/        @purse/sdk    the partner-facing client (phase 4 implements; phase 0 ships its version)
  ids/              @repo/ids     typed-prefix UUID v7 ids shared by both apps
  db/               @repo/db      connection and migration helpers; holds no schema, no URL
  logger/           @repo/logger  structured JSON log lines and build-sha resolution, shared by both apps
  config/           @repo/config  ESLint flat config (with the boundary rule) and tsconfig presets
docker/postgres/    init script for the compose Postgres: two databases, three roles
scripts/            db-setup: the same provisioning against any Postgres you can reach
docs/               system-spec.md (verbatim) and decisions.md
test/               repository-level tests: the boundary lint rule, env isolation
```

Each app owns its Drizzle config and migration folder (`apps/*/drizzle`). Migrations are
forward-only and applied by `pnpm db:migrate`, which runs each app's migrator in its own
process. Reference rows never live in migration history: `pnpm db:seed` upserts them
(today, the Sideout tenant in Purse and its platform ledger accounts) and can be re-run
against any environment.

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
pnpm db:seed                # upserts the Sideout tenant and its platform accounts in Purse; safe to re-run
pnpm dev                    # Purse on :4000, Sideout on :3000
```

Then:

```sh
curl localhost:4000/health   # { data: { sha, migrations, rulesetVersion, sdkVersion, lastReconcile } }
curl localhost:3000/health   # { data: { sha, migrations, purseSdkVersion } }
open http://localhost:3000   # the Sideout shell: "No events yet", plus a beneficiary count read from its database
pnpm --filter @purse/api reconcile   # the seven ledger invariants against the dev database; exits 1 on any failure
```

`GET /internal/reconcile` returns the same report over HTTP behind `INTERNAL_API_TOKEN`
(`Authorization: Bearer ...`); with no token configured it is closed outside tests.

Send `X-Request-Id: anything-you-like` to either and it comes back on the response and in
that service's JSON log line, which is how a Sideout request will be traced into the Purse
calls it makes.

`pnpm db:setup` takes `--admin-url` (or `DATABASE_ADMIN_URL`) for a Postgres that is not
the local default; `apps/*/.env.example` list every variable with a comment.

## How the ledger cannot drift

The short version, until the full write-up lands with the last phase. Purse's ledger
(`apps/purse/src/ledger/`) is an immutable double-entry journal: every entry has at least
two lines, balances per asset inside the transaction that writes it, and is never
updated or deleted. That last part is a property of the database role the API runs as,
not a convention in the code: `purse_app` holds `SELECT` and `INSERT` on the journal and
nothing else, and a test expects the `UPDATE` to fail. Mistakes are corrected by posting a
reversing entry. Balances are derived by summing lines, so any balance at any past moment
is one `WHERE posted_at <= $1` away.

`reconcile()` (`apps/purse/src/ledger/reconcile.ts`) checks the seven invariants from
spec 4.2.4 (the journal nets to zero per asset, every entry balances, no wallet is
negative, settled escrows are empty, payouts equal escrow, snapshots equal derived
balances, every contest entry links to a matching escrow entry; the three about contests
arrive with them in phase 2). It runs in CI against the seeded database, is exposed at
`GET /internal/reconcile`, and its last result is on `/health`. The test worth reading is
`apps/purse/test/ledger/random-ops.test.ts`: ten thousand seeded random operations
(issue, escrow, refund, settle, void, replay, reversal, attempted overdraft), many fired
concurrently, checked against an independent replay of every accepted line, and then
`reconcile()` must come back clean.

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
