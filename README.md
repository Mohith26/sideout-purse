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
  purse/            Purse API. Hono on Node 22, Drizzle + postgres, Zod.   PURSE_DATABASE_URL
  sideout/          Sideout web app. Next.js 15 App Router, Tailwind 4.   SIDEOUT_DATABASE_URL
  purse-embed/      (phase 4) the iframe-hosted identity and wallet flows
  purse-console/    (phase 5) the operator console
packages/
  ui/               @sideout/ui   design tokens, Tailwind theme, primitives (AppShell, StatusPill)
  purse-types/      @purse/types  API error taxonomy, header names, iframe protocol envelope
  purse-sdk/        @purse/sdk    the partner-facing client (phase 4 implements; phase 0 ships its version)
  ids/              @repo/ids     typed-prefix UUID v7 ids shared by both apps
  db/               @repo/db      connection and migration helpers; holds no schema, no URL
  config/           @repo/config  ESLint flat config (with the boundary rule) and tsconfig presets
docker/postgres/    init script for the compose Postgres: two databases, two roles
scripts/            db-setup: the same provisioning against any Postgres you can reach
docs/               system-spec.md (verbatim) and decisions.md
test/               repository-level tests: the boundary lint rule, env isolation
```

Each app owns its Drizzle config and migration folder (`apps/*/drizzle`). Migrations are
forward-only and applied by `pnpm db:migrate`, which runs each app's migrator in its own
process. Reference rows never live in migration history: `pnpm db:seed` upserts them
(today, the Sideout tenant in Purse) and can be re-run against any environment.

## Quickstart

Requires Node 22 (`.nvmrc`), pnpm 11, and a Postgres 16 to talk to.

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
pnpm db:seed                # upserts the Sideout tenant row in Purse; safe to re-run
pnpm dev                    # Purse on :4000, Sideout on :3000
```

Then:

```sh
curl localhost:4000/health   # { data: { sha, migrations, rulesetVersion, sdkVersion, lastReconcile } }
curl localhost:3000/health   # { data: { sha, migrations, purseSdkVersion } }
open http://localhost:3000   # the Sideout shell, reading "no events yet" from its database
```

Send `X-Request-Id: anything-you-like` to either and it comes back on the response and in
that service's JSON log line, which is how a Sideout request will be traced into the Purse
calls it makes.

`pnpm db:setup` takes `--admin-url` (or `DATABASE_ADMIN_URL`) for a Postgres that is not
the local default; `apps/*/.env.example` list every variable with a comment.

## Checks

```sh
pnpm typecheck   # tsc -b over every project reference
pnpm lint        # eslint, including the Sideout/Purse boundary rule and no-console / no-any / no-empty-catch
pnpm test        # vitest, one project per package; the app projects migrate their own *_test databases
pnpm build       # tsup for Purse, next build for Sideout
```

CI (`.github/workflows/ci.yml`) runs all four against a `postgres:16` service container.
