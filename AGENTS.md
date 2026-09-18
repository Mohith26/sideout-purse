# Project agent memory

Sideout (charity beach volleyball product) on Purse (the competition platform it runs on).
`docs/system-spec.md` is the acceptance contract: its MUST statements are load-bearing, its
DEFAULTs are taken unless `docs/decisions.md` records a reason. Section 9 of the spec is the
phase order; section 7 is the banned list (no `any`, no empty `catch`, no `console.log`
outside the logger, no floats in the money path, no gradients or emoji iconography).

## Working here

- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. `.no-mistakes.yaml` and
  `.github/workflows/ci.yml` run the same four; keep them in step.
- Local Postgres: `pnpm db:setup` (any reachable Postgres; writes `apps/*/.env`) or
  `docker compose up -d` plus `cp apps/<app>/.env.example apps/<app>/.env` for both apps (the
  examples match compose), then `pnpm db:migrate` and `pnpm db:seed`. Tests use the `*_test`
  databases and wipe them in each app's `test/global-setup.ts`. A compose volume from
  before phase 1 lacks `purse_migrator`; `pnpm db:setup --admin-url ...` upgrades it in place.
- `pnpm dev` starts Purse on :4000 and Sideout on :3000; both expose `/health`.
- CI also migrates and seeds Purse's `purse` database and runs
  `pnpm --filter @purse/api reconcile`; a failing invariant fails the build.

## Purse roles and the ledger

- Two Purse roles (`docs/decisions.md`): `purse_migrator` owns the databases and runs
  `db:migrate`, `db:seed`, `db:setup` and the test reset (`PURSE_MIGRATOR_DATABASE_URL`);
  `purse_app` is the runtime (`PURSE_DATABASE_URL`), owns nothing, and holds only what
  `apps/purse/drizzle/0002_ledger_roles.sql` and `0004_ledger_guards.sql` grant. Every new
  table needs an explicit `GRANT ... TO purse_app` in a custom migration
  (`db:generate:custom`); an append-only table (journal, audit log) gets `SELECT, INSERT`
  only, and a table whose columns a balance depends on gets column-level `UPDATE`
  (`accounts`, `tenants`: `status, updated_at`). `test/ledger/roles.test.ts` fails on a
  table with no grant. Tests take the runtime connection from `test/helpers.ts`
  (`connectRuntime`) and the owner connection only for fixtures and teardown
  (`connectMigrator`). The API refuses to boot on a role that can `UPDATE` the journal or
  the audit log (`src/ledger/role-check.ts`).
- The ledger lives in `apps/purse/src/ledger/`. `postEntry` is the only way value moves
  (rules 1-7 of spec 4.2.2, the wallet and escrow non-negative guard, sorted `FOR UPDATE`
  locks, idempotent replay by (tenant, key) with a request-hash conflict check); the 4.2.5
  flows are typed wrappers in `flows.ts`; corrections are `reverseEntry`, never an update,
  and take the acting tenant. Pass a transaction to post atomically with your own writes.
  A deferred constraint trigger (`journal_lines_entry_balanced`) re-checks rules 1-3 at
  commit for any writer; a test that needs to commit a broken entry as the owner disables
  it for that one transaction (see `test/ledger/reconcile.test.ts`). `reconcile()`
  (`reconcile.ts`) is the invariant registry; I4, I5 and I7 are `not_applicable` entries
  phase 2 replaces.
- Money is `bigint` end to end; raw SQL sums are cast `::text` and parsed with `BigInt`.
- The randomized ledger test (`apps/purse/test/ledger/random-ops.test.ts`) runs 10,000
  operations by default and refuses fewer under `CI`. Locally:
  `LEDGER_RANDOM_OPS=500 LEDGER_RANDOM_SEED=1 pnpm --filter @purse/api test test/ledger/random-ops`.

## The boundary, and where things go

- Sideout imports from Purse only through `@purse/sdk` and `@purse/types`; Purse imports
  nothing from Sideout. `packages/config/eslint/boundary.js` enforces it and
  `test/boundary.test.ts` proves it. Neutral shared code lives in `@repo/*`.
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
