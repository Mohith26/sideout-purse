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
  databases and wipe them in each app's `test/global-setup.ts`.
- `pnpm dev` starts Purse on :4000 and Sideout on :3000; both expose `/health`.

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
