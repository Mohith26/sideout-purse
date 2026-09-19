# The public status page

Spec section 12, stretch item 5: "a public status page rendering the live invariant
panel". It is the operator console's invariant panel (spec 4.10) read-only, on a page
anyone can open, fed by a public endpoint on the Purse API that reads the stored
reconcile record and never runs `reconcile()` for a visitor.

## Where

| What | URL |
|---|---|
| The page, on the deployed console | https://purse-console-production.up.railway.app/status |
| The feed it renders, on the API | https://purse-production-b87b.up.railway.app/v1/status (also at `/status`) |

Locally: `pnpm dev`, then http://localhost:4200/status and http://localhost:4000/v1/status.

## What it shows

- **A headline**: `All invariants hold`, `I3 failing` (the ids, nothing else), `Not
  checked yet` (no run recorded), or which service is not answering; and when the last
  reconcile ran, from where (the 15-minute job, the console panel, the internal route,
  the command line) and how long it took.
- **The three services** (Purse API, operator console, Sideout) as green or red with the
  time each was last checked. The console probes the API's feed and Sideout's `/health`
  from the server with a three-second timeout, keeps each answer for 30 seconds, and
  when a probe fails keeps showing the last good answer, marked stale, for up to two
  minutes before calling the service down. The visitor's browser fetches nothing from
  either origin.
- **The seven invariants** (`apps/purse/src/ledger/reconcile.ts`) with the outcome the
  newest `reconcile_runs` row recorded for each: holds, failing, or not checked.
- **Recent reconcile runs**: the newest twenty, each with its time, outcome (`clean`, or
  `failing: I3`), source and duration.
- **The build**: the API's commit, migration state (`17 applied, none pending`), active
  ruleset version and SDK version, and the console's commit.

The page reloads itself every 60 seconds with a `meta refresh`, so it works the same in
a browser with JavaScript off; it carries no script of its own.

## What it deliberately hides

- Every invariant's `detail` sentence. The console panel's detail quotes sums, counts,
  account and user ids ("wallet acct_... holds -125 POINTS"); the public feed strips it,
  and `apps/purse/test/status.test.ts` checks that a failing run's detail never reaches
  the wire. A failing invariant is named by id and name only.
- Anything tenant-shaped: no tenant, contest, user, balance, entrant count, or activity
  count. The only numbers are the migration counts, run durations and the run history.
- Whether the operator console can sign anyone in: the page is outside the console
  frame, reads no session and calls no `/console/*` route.
- The Purse database, its host, and every key.

## How it is protected

- `GET /v1/status` (`apps/purse/src/routes/status.ts`) needs no key, answers 200 whatever
  the last run found (`status: ok | failing | unknown` says), assembles one answer at
  most every 30 seconds per process and serves it from memory in between
  (`Cache-Control: public, max-age=30`), and spends from the caller's address bucket like
  the embed's routes (`RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SECOND`, `TRUSTED_PROXY_HOPS`
  to read the client address behind the load balancer). A crawler hammering it gets
  cached answers, then 429s.
- The console's middleware (`apps/purse-console/src/middleware.ts`) opens exactly
  `/status`; `/status/anything` and every other page still redirect to sign-in
  (`test/middleware.test.ts` pins the list).

## Configuration

One optional console variable, `SIDEOUT_ORIGIN` (`apps/purse-console/src/env.ts`): the
Sideout origin whose `/health` the page probes, `https://sideout-production-5898.up.railway.app`
on the deployment. Unset, the Sideout row reads "not configured" and nothing is probed.
The API needs nothing new: the feed reads the `reconcile_runs` record phase 9 added.

## The uptime check

Keep pointing the check that pages at the API's `/health` (`docs/deploy.md`, "Uptime and
paging"): it answers 503 while the last reconcile failed, and that is the signal. The
status page is for people, and it always answers 200 so that it can say what is wrong. If
you want a second check on the page itself, expect HTTP 200 from
`https://purse-console-production.up.railway.app/status` with the body containing
`data-status="ok"`; `data-status` is `failing` when an invariant fails, `degraded` when a
service is down, `unknown` before the first recorded run.
