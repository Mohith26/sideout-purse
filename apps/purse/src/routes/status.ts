import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SDK_VERSION } from '@purse/sdk';
import { STATUS_RUN_HISTORY, type PublicStatusResource, type ReconcileRunResource, type StatusInvariantResource } from '@purse/types';
import { migrationState, type Sql } from '@repo/db';

import type { Db } from '../db/client';
import { rulesets, type ReconcileRun } from '../db/schema';
import { ApiFailure, ok } from '../http/envelope';
import { rateLimitByAddress, type TokenBuckets } from '../http/rate-limit';
import type { RequestScope } from '../http/request-id';
import { INVARIANTS, recentReconcileRuns, summarise } from '../ledger';

/**
 * `GET /status` (also at `/v1/status`), spec section 12 stretch item 5: the public status
 * feed the console's `/status` page renders. Anyone may read it, so it is a read of what
 * is already stored and nothing more: the last `STATUS_RUN_HISTORY` rows of
 * `reconcile_runs` (the 15-minute job, the internal route and the console panel all
 * record there), the newest one's per-invariant outcome, and the same build facts
 * `/health` reports. It never runs `reconcile()`: an anonymous visitor cannot make the
 * database do seven full-table checks, and the panel that can is behind the operator's
 * session.
 *
 * What it leaves out, on purpose: every invariant's `detail` sentence (it quotes sums,
 * counts and ids), and anything tenant-shaped. A failing invariant is named by id and
 * name, nothing else. Unlike `/health` the answer is 200 whatever the last run found
 * (`status` says); `/health` is the endpoint that pages.
 *
 * One answer is assembled at most every `ttlMs` (30 seconds) per process and served from
 * memory in between, with `Cache-Control` saying so, and the route spends from the
 * address's token bucket like the embed's routes do, so a crawler cannot make it a load.
 */
export type StatusDeps = {
  sql: Sql;
  db: Db;
  migrationsFolder: string;
  sha: string;
  buckets: TokenBuckets;
  trustedProxyHops: number;
  /** How long an assembled answer is served for; 30 seconds unless a test says otherwise. */
  ttlMs?: number;
  clock?: () => number;
};

export const DEFAULT_STATUS_TTL_MS = 30_000;

type Cached = { body: PublicStatusResource; at: number };

export function statusRoutes(deps: StatusDeps) {
  const clock = deps.clock ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_STATUS_TTL_MS;
  const maxAge = Math.max(1, Math.round(ttlMs / 1000));
  let cached: Cached | undefined;
  let building: Promise<PublicStatusResource> | undefined;

  return new Hono<RequestScope>().get('/status', rateLimitByAddress(deps.buckets, { trustedProxyHops: deps.trustedProxyHops }, clock), async (c) => {
    const now = clock();
    let body: PublicStatusResource;
    if (cached !== undefined && now - cached.at < ttlMs) {
      body = cached.body;
    } else {
      // One build at a time: a burst of visitors on a cold cache shares the same read.
      building ??= assemble(deps, now).finally(() => {
        building = undefined;
      });
      try {
        body = await building;
      } catch (error) {
        c.get('logger').error('status: database unreachable', { reason: error instanceof Error ? error.message : String(error) });
        throw new ApiFailure({ type: 'internal_error', code: 'database_unavailable', message: 'Database is unreachable' }, 503);
      }
      cached = { body, at: now };
    }
    c.header('Cache-Control', `public, max-age=${maxAge}`);
    return ok(c, body);
  });
}

async function assemble(deps: StatusDeps, now: number): Promise<PublicStatusResource> {
  const migrations = await migrationState(deps.sql, deps.migrationsFolder);
  const migrated = migrations.pending === 0;
  const [rulesetVersion, runs] = migrated ? await Promise.all([activeRulesetVersion(deps.db), recentReconcileRuns(deps.db, STATUS_RUN_HISTORY)]) : [null, []];
  const newest = runs[0];
  const summaries: ReconcileRunResource[] = runs.map(summarise);
  return {
    status: newest === undefined ? 'unknown' : newest.ok ? 'ok' : 'failing',
    sha: deps.sha,
    migrations,
    rulesetVersion,
    sdkVersion: SDK_VERSION,
    invariants: invariantsOf(newest),
    lastRun: summaries[0] ?? null,
    runs: summaries,
    generatedAt: new Date(now).toISOString(),
  };
}

/** The registry's seven, in order, each with what the newest run recorded for it; `unknown` before any run, or for an id a run did not report. */
function invariantsOf(run: ReconcileRun | undefined): StatusInvariantResource[] {
  const reported = new Map(run?.report.invariants.map((each) => [each.id, each.status]) ?? []);
  return INVARIANTS.map((invariant) => ({ id: invariant.id, name: invariant.name, status: reported.get(invariant.id) ?? 'unknown' }));
}

async function activeRulesetVersion(db: Db): Promise<string | null> {
  const [row] = await db.select({ version: rulesets.version }).from(rulesets).where(eq(rulesets.active, true));
  return row?.version ?? null;
}
