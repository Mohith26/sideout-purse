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
  databases, wipe them in each app's `test/global-setup.ts`, and need no `.env`: each app's
  `test/setup-env.ts` falls back to `db:setup`'s default URLs (CI's or a `.env`'s values
  win). A compose volume from before phase 1 lacks `purse_migrator`;
  `pnpm db:setup --admin-url ...` upgrades it in place.
- `pnpm dev` starts Purse on :4000 and Sideout on :3000; both expose `/health`.
- CI also migrates and seeds Purse's `purse` database and runs
  `pnpm --filter @purse/api reconcile`; a failing invariant fails the build.

## Purse roles and the ledger

- Two Purse roles (`docs/decisions.md`): `purse_migrator` owns the databases and runs
  `db:migrate`, `db:seed`, `db:setup` and the test reset (`PURSE_MIGRATOR_DATABASE_URL`);
  `purse_app` is the runtime (`PURSE_DATABASE_URL`), owns nothing, and holds only what
  `apps/purse/drizzle/0002_ledger_roles.sql`, `0004_ledger_guards.sql` and
  `0006_contest_guards.sql` grant. Every new table needs an explicit
  `GRANT ... TO purse_app` in a custom migration (`db:generate:custom`); an append-only
  table (journal, audit log, `contest_results`, `idempotency_keys`) gets `SELECT, INSERT`
  only, and a table with columns that legitimately change gets column-level `UPDATE`
  (`accounts`, `tenants`: `status, updated_at`; `contests`: `state`, `settled_at`,
  `locks_at` and the draft-editable fields; `contest_participants`: `state`;
  `contest_scores`: `superseded_by`). `test/ledger/roles.test.ts` fails on a table with
  no grant and pins the updatable columns of every contest table. Tests take the runtime
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

- `apps/purse/src/contests/transition.ts` is the only writer of `contests.state`
  (`test/contests/transition.test.ts` greps for any other); the state table is
  `states.ts` and the database holds the same table in the `contests_state_machine`
  trigger (`drizzle/0006_contest_guards.sql`), so change both together. `settling` is
  entered and left inside `executeSettlement`'s transaction under the contest row lock
  (`lockContest`, `SELECT ... FOR UPDATE`), which every contest write starts with.
- `apps/purse/src/settlement/` is pure: no database, clock or randomness may be imported
  there, and `previewSettlement` and `closeContest` must keep calling the same `settle` and
  `payoutHash`. The rounding rule and each structure's meaning are documented in
  `settle.ts` and `settlement/README.md`; `docs/decisions.md` (phase 2) records the rules
  the spec left open (expected results, finished attempts, the hash's canonical form).
- Every contest mutation takes an `idempotencyKey` and goes through `idempotent()`
  (`contests/idempotency.ts`, backed by `idempotency_keys`); money moves only through the
  ledger's typed flows inside the same transaction. New mutations follow the same shape:
  lock the contest first, post through `postEntry`'s helpers, record with `idempotent`.
- The eligibility hook `contests/eligibility.ts` always allows and is phase 3's to replace.

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
