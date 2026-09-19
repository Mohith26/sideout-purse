# Deploying Sideout on Purse

What a host needs to run the two services, and how the public demo is deployed on Railway
("Deployed", below). Spec section 10 is the contract; `docs/decisions.md` (phase 9) records
where this deploy departs from its defaults.

## The three processes, one Postgres

| Service | Image | Serves | Health |
|---|---|---|---|
| `purse` | `apps/purse/Dockerfile` | the Purse API, the contest engine, the ledger, the webhook dispatcher, and the embed app under `/embed` | `GET /health`: sha, migration state, active ruleset version, SDK version, last reconcile result; 503 while the last reconcile failed |
| `purse-console` | `apps/purse-console/Dockerfile` | the operator console, talking to the API's `/console/*` server-to-server | `GET /health`: sha, and whether the API answers |
| `sideout` | `apps/sideout/Dockerfile` | the Sideout web app | `GET /health`: sha, migration state, SDK version, and what Purse's `/health` says |
| `pingpong` | `apps/pingpong/Dockerfile` | the second tenant, the office ping-pong ladder (`docs/second-tenant.md`) | `GET /health`: the same shape as Sideout's |

Every image is multi-stage (build, a clean production install, runtime), runs as the
unprivileged `node` user, carries a Docker `HEALTHCHECK` on its `/health`, and is built
from the repository root (`docker build -f apps/purse/Dockerfile .`), because the
workspace is one pnpm install. `test/docker.test.ts` pins that shape. The Purse and Sideout
start commands (`apps/*/docker-entrypoint.sh`) run the forward-only migrations first and
exit non-zero on a migration failure, so a deploy whose migration fails never starts a
server on a half-migrated schema; the Purse entrypoint then drops the owner role's
connection string from the environment before serving, and the API refuses to boot on a
role that could rewrite the journal.

One Postgres holds two logical databases, `purse` and `sideout`, with three roles
(decision D2): `purse_migrator` owns Purse's database and runs its migrations, seeds and
the demo reset; `purse_app` is the API's runtime role and cannot rewrite the journal;
`sideout_app` is Sideout's only role. `pnpm db:setup --admin-url <url> --no-write-env
--no-test-databases` provisions exactly that on any Postgres you can reach as an admin.

## Environment variables

`apps/purse/src/env.ts` and `apps/sideout/src/env.ts` are the authoritative lists (each
app's `.env.example` is the template). What a public deploy has to set:

**purse** (and the `purse-reconcile` cron, which references the same `PURSE_DATABASE_URL`
and `PURSE_SECRET_KEY`):

| Variable | Set it to |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `PURSE_DATABASE_URL` | `postgresql://purse_app:...@<host>/purse?sslmode=require` |
| `PURSE_MIGRATOR_DATABASE_URL` | the `purse_migrator` URL; the entrypoint uses it for `db:migrate` and unsets it before the server starts |
| `PURSE_SECRET_KEY` | 64+ random characters: every derived key (embed sessions, sign-in codes, webhook secret envelopes) comes from it. Changing it invalidates every stored webhook secret. |
| `INTERNAL_API_TOKEN` | random: bearer for `GET /internal/reconcile`, which the deployed Playwright run uses |
| `ALLOW_DEV_PROVIDERS` | `true`: only the `dev` identity, geo and risk providers exist, and production refuses them unless this says so on purpose (`docs/providers.md`) |
| `TRUSTED_PROXY_HOPS` | `1` behind Railway's edge |
| `PURSE_TENANT_ORIGINS` | the Sideout origin: the seed and the reset add it to the tenant's allowlist (`frame-ancestors`, CORS, the handshake) |
| `WEBHOOK_DISPATCHER` | `on` in the one API process |
| `WEBHOOK_ALLOWED_HOSTS` | **unset**: it exempts named hosts from webhook destination validation (`docs/webhooks-security.md`), so a production deployment leaves it empty and refuses every private destination. A non-empty list is logged at `warn` on boot. |
| `WEBHOOK_ALLOWED_PORTS` | **unset**: empty means every port is allowed, which is the default; set it only to pin the ports this deployment will dial. |
| `BUILD_SHA` | the deployed commit (`railway up` uploads the working tree without `.git`) |
| `RAILWAY_DOCKERFILE_PATH` | `apps/purse/Dockerfile` |

**purse-console**: `NODE_ENV=production`, `PORT=4200`, `PURSE_API_ORIGIN=https://<purse
domain>` (must be `https://` in production: the session token travels on it), `BUILD_SHA`,
`RAILWAY_DOCKERFILE_PATH=apps/purse-console/Dockerfile`, and optionally
`SIDEOUT_ORIGIN=https://<sideout domain>` so the public `/status` page (`docs/status.md`)
can probe Sideout's `/health`.

**sideout**:

| Variable | Set it to |
|---|---|
| `NODE_ENV`, `PORT` | `production`, `3000` |
| `SIDEOUT_DATABASE_URL` | `postgresql://sideout_app:...@<host>/sideout?sslmode=require` |
| `SESSION_SECRET` | 32+ random characters; signs the session cookie and one-time codes |
| `TRUSTED_PROXY_HOPS` | `1` |
| `PURSE_API_URL` | the Purse origin the server calls |
| `SIDEOUT_PURSE_SECRET_KEY` | the tenant's `sk_sandbox_...` (the seed prints it once, below) |
| `PURSE_WEBHOOK_SECRET` | the `whsec_...` of the webhook endpoint registered for `https://<sideout domain>/api/webhooks/purse` (below) |
| `NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PURSE_ORIGIN`, `NEXT_PUBLIC_PURSE_TENANT_ID` | what the SDK mounts flows with: the `pk_sandbox_...` key, the Purse origin, the tenant id (`tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9` is the seeded tenant). Build-time values: the Dockerfile declares them as build arguments and Railway hands service variables to both the build and the runtime. |
| `BUILD_SHA` | the deployed commit: `/health`, and the service worker's cache version, so a new build must carry a new sha or phones keep the previous pages |
| `RAILWAY_DOCKERFILE_PATH` | `apps/sideout/Dockerfile` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | unset on the demo (below, "What the demo does not do") |
| `DEMO_ACCOUNTS` | `true` for the public demo's sign-in picker (`docs/demo-accounts.md`), otherwise unset. A build-time value too: the Dockerfile declares it as a build argument (default `false`), Railway hands the service variable to the build, and a build made for the other setting refuses to boot. `NEXT_PUBLIC_DEMO_ACCOUNTS` is derived from it by `next.config.ts` and is never set by hand. |

**demo-reset** (the nightly cron) needs both halves' variables: `DEMO_RESET=allow`, the
Purse owner and runtime URLs, `PURSE_SECRET_KEY`, `PURSE_TENANT_ORIGINS`, and Sideout's
`SIDEOUT_DATABASE_URL`, `SESSION_SECRET`, `PURSE_API_URL`, `SIDEOUT_PURSE_SECRET_KEY`,
`PURSE_WEBHOOK_SECRET` and the three `NEXT_PUBLIC_PURSE_*`, every one a Railway reference
(`${{purse.PURSE_SECRET_KEY}}`, `${{sideout.SESSION_SECRET}}`, ...) so each secret exists
in one place; plus `RAILWAY_DOCKERFILE_PATH=docker/demo-reset/Dockerfile`.

## Deployed

The public demo runs on Railway, project `sideout-purse` (id
`d9c95fab-9880-4708-80f3-22893aae9e49`), environment `production`, in the personal
workspace, in the workspace's default region (`asia-southeast1`, the same as the sibling
Sideout-on-Lucra project). Railway-provided domains, no custom DNS (docs/decisions.md,
phase 9):

| Service | URL |
|---|---|
| Sideout | https://sideout-production-5898.up.railway.app |
| Purse API and embed | https://purse-production-b87b.up.railway.app (`/health`, `/embed/`, `/responsible-play`, `/support`, `/v1/*`) |
| Purse operator console | https://purse-console-production.up.railway.app (sign in as `admin@purse.local`; the seeded password is kept as the `purse-console` service's `PURSE_CONSOLE_ADMIN_PASSWORD` variable, read by no process, for the dashboard's eyes only; `pnpm --filter @purse/api db:seed -- --print-operator-password --rotate-operator-password` through the proxy sets a new one) |
| Ping-pong (the second tenant) | https://pingpong-production-bc24.up.railway.app (sign in with any name and the office code, the `pingpong` service's `OFFICE_CODE` variable; `docs/second-tenant.md`) |

Plus `Postgres` (Railway's `postgres-ssl` image, one 50 GB volume, the two logical databases
above, reached by the services at `postgres.railway.internal:5432` and from a workstation
through the service's public TCP proxy, `railway tcp-proxy list --service Postgres`), and
two cron services, `purse-reconcile` and `demo-reset` (below). Each service's settings
(Dockerfile path, health check path with a 180 s timeout, restart policy `ON_FAILURE` with 10
retries for the three web services, `NEVER` for the crons, the cron schedules and start
commands) live on the service, set once through Railway's GraphQL API
(`serviceInstanceUpdate`), because the config-as-code file would apply to every service
built from the root.

### Public demo

Deployed commit: `c4469b5` (2026-09-19), all six services (the five above and `pingpong`),
with `DEMO_ACCOUNTS=true` on the `sideout` service: `/sign-in` offers the six demo accounts
(`docs/demo-accounts.md`) and `/health` on Sideout reports `demoAccounts: true`. This deploy
carried the SSE live scoring (`docs/live.md`) and the signed score attestation
(`docs/attestation.md`): Purse's migrations went to 19 (`user_devices` and its guards),
Sideout's to 6 (`team_devices`). Verified on the live origins after the redeploy: every
`/health` reports the commit with no pending migration and the crons rebuilt at it (a
scheduled reconcile ran clean four minutes after the API came up); the console's public
`/status` shows the seven invariants holding; a stream on `/api/live/tournaments/<Sandbar>`
opened, heartbeat, and delivered the `score`, `match` and `standings` events the moment a
scoreline landed; Captain B (a demo account) checked a phone in on the register screen
(mirrored to Purse), submitted the answering scoreline signed, the match went final and
`confirmed`, the match page marks that reading `Signed` and Captain A's `Unsigned`, and the
`purse_calls` audit shows Purse's answer to the push: team B's two scores `verified` against
the registered device, team A's `none`; the ping-pong ladder answers. The demo reset was not
run after this deploy (the roster's seeded states were intact and the nightly reset keeps
them); run it before a recording. To turn the picker off, unset `DEMO_ACCOUNTS` on `sideout`
and redeploy it (the build argument follows the variable).

The console admin password was rotated the same day (the seed's `--print-operator-password
--rotate-operator-password` through the Postgres proxy, the value written straight into the
`purse-console` service's `PURSE_CONSOLE_ADMIN_PASSWORD` variable and nowhere else) and
verified: `POST /console/auth/login` answers 201 for `admin@purse.local`, the console's
sign-in form lands on the contests list, and the ledger explorer, the replay and the
invariants pages render. Two things worth knowing when checking that login by hand: the API
route is `/console/auth/login` (a `POST /console/login` answers 401 `missing_session`, which
is the authenticated stack, not a wrong password), and the nightly demo reset never rotates
the password: `operators` and `operator_sessions` are kept tables, and the reset seeds the
admin without `rotate`, which leaves an existing account untouched. Only a seed run with
`--rotate-operator-password` changes it, so whoever runs one updates the variable.

Previous: `c5082c4` (2026-09-19), the demo-accounts switch; `9d8dc37` (2026-09-19), the
second tenant (`docs/second-tenant.md`).

How it was deployed, with the Railway CLI (`railway`, signed in) from the repository root:

```sh
railway init --name sideout-purse --workspace <workspace-id> --json     # project; links the directory
railway add --database postgres --json
railway tcp-proxy create --port 5432 --service Postgres                 # a public port for db:setup and the seed
railway variable list --service Postgres --json                          # PGUSER, PGPASSWORD, PGDATABASE, RAILWAY_PRIVATE_DOMAIN
# The admin URL through the environment, not the command line: pnpm echoes a script's arguments.
DATABASE_ADMIN_URL='postgresql://postgres:<pw>@<proxy host>:<proxy port>/railway?sslmode=require' \
  pnpm db:setup --no-write-env --no-test-databases \
  --purse-password ... --purse-migrator-password ... --sideout-password ...
for s in purse purse-console sideout purse-reconcile demo-reset; do railway add --service $s --json; done
railway domain --service purse --port 4000; railway domain --service purse-console --port 4200; railway domain --service sideout --port 3000
railway variable set NODE_ENV=production --service purse --skip-deploys           # ... every variable in the tables above;
printf '%s' "$SECRET" | railway variable set PURSE_SECRET_KEY --stdin --service purse --skip-deploys   # secrets through stdin
# service settings (Dockerfile path, health check, restart policy, cron, start command): serviceInstanceUpdate, see above
railway up --service purse --detach            # then poll `railway deployment list --service purse --json` and /health
PURSE_DATABASE_URL=... PURSE_MIGRATOR_DATABASE_URL=... PURSE_TENANT_ORIGINS=https://<sideout domain> \
  pnpm --filter @purse/api db:seed -- --print-keys --print-operator-password   # through the proxy; prints the sandbox keys and the admin password once
curl -X POST https://<purse domain>/v1/webhooks/endpoints -H "Authorization: Bearer sk_sandbox_..." -H "Idempotency-Key: deploy-webhook-endpoint-1" \
  -H 'content-type: application/json' -d '{"url":"https://<sideout domain>/api/webhooks/purse","subscribedEvents":[...all eight...]}'   # prints whsec_... once
railway variable set ... --service sideout      # the keys and the webhook secret
railway up --service purse-console --detach; railway up --service sideout --detach
railway up --service purse-reconcile --detach; railway up --service demo-reset --detach
railway restart --service demo-reset --yes     # the first seed of Sideout, mirrored to Purse (below)
```

**To redeploy** a commit (from a clean checkout of it; `railway link --project
d9c95fab-9880-4708-80f3-22893aae9e49 --environment production` if this directory is not
linked):

```sh
SHA=$(git rev-parse HEAD)
for s in purse purse-console sideout purse-reconcile demo-reset pingpong; do railway variable set "BUILD_SHA=$SHA" --service $s --skip-deploys; done
for s in purse purse-console sideout purse-reconcile demo-reset pingpong; do railway up --service $s --detach; done
```

Then check each `/health` reports `sha` equal to the commit and `migrations.pending` 0
(`railway deployment list --service purse --json` for the build, `railway logs --service purse`
for the boot: the migrate summary, the runtime role check, `listening`). The three web
services deploy independently; a Purse migration goes out before the Sideout build that
needs it. The cron services are rebuilt from the same commit so the reset and the reconcile
run the code that is deployed.

## Cron: reconcile every 15 minutes, reset nightly

Two Railway cron services, each a container that starts on its schedule, does its job and
exits (a run that exits non-zero shows as failed in `railway logs --service <name>` and the
dashboard); Railway skips a scheduled run while the previous one is still going.

- **`purse-reconcile`**, schedule `*/15 * * * *`, the Purse image with start command
  `node dist/reconcile.js --source schedule`: runs the seven ledger invariants
  (`apps/purse/src/ledger/reconcile.ts`) as the runtime role, records the run in
  `reconcile_runs`, logs each invariant, and a failing invariant is logged at `error` level
  and exits 1. `GET /health` on Purse reports the newest recorded run (`reconcile`) and
  answers **503 with `status: "failing"`** while the last run failed: that is what pages
  you (below). `GET /internal/reconcile` and the console's invariant panel record runs too,
  so the report on `/health` is whatever ran last. The record is append-only for the
  runtime; a failed run stays on it until a clean one follows.
- **`demo-reset`**, schedule `0 10 * * *` (10:00 UTC, 03:00 Pacific), the
  `docker/demo-reset` image (both apps' bundled reset scripts, no server): resets Purse
  first, as `purse_migrator` (every demo row deleted; the tenant, its origins, its API
  keys, the webhook endpoints, the ruleset, the operators and the reconcile record are kept,
  `apps/purse/src/db/demo-reset.ts`), reapplies the seed, then empties Sideout's database,
  writes the seed anchored on the day and mirrors the seeded events to the fresh Purse
  through the API, so the demo is the known-good state every morning: nine events across
  every tournament status, contests in every state, every verification state, the Sandbar
  Classic live with one dispute and one first reading, the Dune Cup one dispute from its
  close, the Community Cup taking free registrations.

  The reset is protected the way the sibling protects its reset route, adapted to a job
  with no HTTP surface: it runs only with `DEMO_RESET=allow` in its environment, only
  against a database named `purse` / `sideout` (or a demo or test one), and only the
  `demo-reset` service holds the owner role's connection string and that switch; the API
  process never holds either (its entrypoint drops the migrator URL before serving), which
  is why the reset is not a route on the API. To reset right now: `railway restart --service
  demo-reset --yes`, then `railway logs --service demo-reset` (`demo reset complete`, with
  the counts, or the failure). Run it before a recording, and before rerunning the
  end-to-end flows (below), which consume the seed.

## Uptime and paging

Railway's own health check (`healthcheckPath: /health`, 180 s) gates every deploy of the
three web services: a deployment that never answers 200 is never switched to, and the
previous one keeps serving. For monitoring between deploys, point an external HTTP check
(any checker; none is signed up for) at:

| Check | URL | Expect |
|---|---|---|
| Purse | `https://purse-production-b87b.up.railway.app/health` | HTTP 200; body `{"data":{"status":"ok",...,"reconcile":{"ok":true,...}}}`. A 503 with `"status":"failing"` means the last reconcile found a violated invariant (`data.reconcile.failed` names it): page. A 503 with `"code":"database_unavailable"` means the database is down. |
| Sideout | `https://sideout-production-5898.up.railway.app/health` | HTTP 200; body `{"data":{...,"purse":{"reachable":true,"status":"ok",...}}}`. `purse.reachable: false` means Sideout is up but cannot ask Purse; `purse.status: "failing"` relays Purse's failed reconcile. Sideout itself answers 503 only when its own database is unreachable. |
| Console | `https://purse-console-production.up.railway.app/health` | HTTP 200; `{"data":{"sha":"...","api":"ok"}}`; `api: "unreachable"` or `"failing"` names the API's state. |

For people rather than checkers, the console's public `/status` page renders the stored
invariant record, the run history and the three services' health (`docs/status.md`).

Every line the three services log is JSON with `service`, `level`, `time`, `msg` and a
`requestId` on request-scoped lines; Sideout mints the id at its edge (`X-Request-Id`),
sends it on every Purse call and Purse echoes it, so `railway logs --service purse --filter
<id>` and `railway logs --service sideout --filter <id>` show one request across the
boundary.

## The end-to-end flows against the deployment

`apps/sideout/e2e/flows.spec.ts` (spec section 8: the Player flow and the Organizer flow)
runs against any origin `BASE_URL` names. Against the demo, with the Railway CLI linked to
the project (the run mints session cookies with the deployment's own secret and reads the
invariant report with the API's internal token, both read from the service variables):

```sh
railway restart --service demo-reset --yes && sleep 90     # the flows consume the seed; start from the known-good state
BASE_URL=https://sideout-production-5898.up.railway.app \
E2E_PURSE_URL=https://purse-production-b87b.up.railway.app \
SESSION_SECRET="$(railway variable list --service sideout --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["SESSION_SECRET"])')" \
E2E_PURSE_INTERNAL_TOKEN="$(railway variable list --service purse --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["INTERNAL_API_TOKEN"])')" \
pnpm --filter @sideout/web e2e --project flows
```

Locally the same file runs after the screen smoke as part of `pnpm --filter @sideout/web
e2e`, against the production build on the seeded databases (the e2e global setup runs the
demo reset first). Last run against the deployment: both flows passed at the commit
`/health` reports.

## What the demo does not do

- **Sign in with a phone.** No SMS provider is chosen (docs/decisions.md, phase 6):
  production answers `POST /api/auth/request-code` with 503 `sms_unavailable`, and the
  embed's sign-in is off the same way. The seeded screens are all readable without a
  session; the flows sign in by minting a session with the deployment's secret. The way in
  for a visitor is the demo-accounts picker (`docs/demo-accounts.md`): with
  `DEMO_ACCOUNTS=true` on the `sideout` service, `/sign-in` offers six seeded people and
  `/health` reports `demoAccounts: true`.
- **Take a donation.** No Stripe account is configured, so registering for an event with an
  entry donation answers 503 `donation_provider_unavailable`; the free-entry Community Cup
  registers without one. Under `DEMO_ACCOUNTS=true` the `dev` donation provider takes the
  entry donation instead (it settles fifteen seconds later, nothing is charged), so the
  paid events register too; a configured Stripe key still wins.
- **Real identity, geolocation or risk vendors.** The `dev` providers run with
  `ALLOW_DEV_PROVIDERS=true`; `docs/providers.md` is the seam table.
- **Custom domains, a CDN, or more than one replica of anything** (the rate limiter and the
  webhook dispatcher are in-process).

## The fourth service

The second tenant (`apps/pingpong`, stretch item 4) has its own image, entrypoint, health
check and variables, following the pattern above; `docs/second-tenant.md` lists them and
the `PURSE_PINGPONG_ORIGINS` variable the `purse` service needs for it. Deployed
2026-09-19 at commit `9d8dc37` as the `pingpong` service
(https://pingpong-production-bc24.up.railway.app), with the five existing services
redeployed at the same commit first so the `purse` and `demo-reset` images carry the second
tenant's seed; `docs/second-tenant.md` ("Deployed") has the steps and what was verified on
the live origin. The redeploy loop above now includes it.

## Running it anywhere else

Any host that runs three containers and a Postgres will do: build the three images from the
repository root, provision the databases with `pnpm db:setup`, set the variables above,
start `purse` (it migrates, then serves), seed once (`pnpm --filter @purse/api db:seed --
--print-keys`, then Sideout's `db:seed`, or the `docker/demo-reset` image with
`DEMO_RESET=allow`), register the webhook endpoint, start the other two, and schedule the
two jobs with whatever cron the host offers (`node dist/reconcile.js --source schedule` in
the Purse image; `demo-reset` in the reset image).
