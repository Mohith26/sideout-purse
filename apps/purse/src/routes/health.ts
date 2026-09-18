import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SDK_VERSION } from '@purse/sdk';
import { migrationState, type MigrationState, type Sql } from '@repo/db';

import type { Db } from '../db/client';
import { rulesets } from '../db/schema';
import { ApiFailure, ok } from '../http/envelope';
import type { RequestScope } from '../http/request-id';
import { lastReconcileRun, type ReconcileSummary } from '../ledger';

/**
 * `GET /health` (also at `/v1/health`), spec 4.7 and section 10: commit sha, migration
 * state, active ruleset version, SDK version and the last reconcile result.
 * `rulesetVersion` is the active `rulesets` row's version, `null` on a database that has
 * been migrated but not seeded, so the shape is stable for uptime checks. `reconcile` is
 * the newest `reconcile_runs` row (the 15-minute job, `GET /internal/reconcile` and the
 * console's panel all record one; `null` before the first run). `status` sums it up:
 * `ok`, or `failing` when the last run found a violated invariant, in which case the
 * response is 503 so an uptime check on the status code alone pages someone (spec section
 * 10: "a failing invariant pages you"); a database that cannot be reached is 503 too.
 *
 * The response never includes a connection string, a key, or a hostname.
 */
export type HealthReport = {
  status: 'ok' | 'failing';
  sha: string;
  migrations: MigrationState;
  rulesetVersion: string | null;
  sdkVersion: string;
  reconcile: ReconcileSummary | null;
};

export type HealthDeps = {
  sql: Sql;
  db: Db;
  migrationsFolder: string;
  sha: string;
};

export function healthRoutes(deps: HealthDeps) {
  return new Hono<RequestScope>().get('/health', async (c) => {
    let migrations: MigrationState;
    let rulesetVersion: string | null;
    let reconcile: ReconcileSummary | null;
    try {
      migrations = await migrationState(deps.sql, deps.migrationsFolder);
      rulesetVersion = migrations.pending === 0 ? await activeRulesetVersion(deps.db) : null;
      reconcile = migrations.pending === 0 ? await lastReconcileRun(deps.db) : null;
    } catch (error) {
      c.get('logger').error('health: database unreachable', { reason: error instanceof Error ? error.message : String(error) });
      throw new ApiFailure(
        { type: 'internal_error', code: 'database_unavailable', message: 'Database is unreachable' },
        503,
      );
    }

    const failing = reconcile !== null && !reconcile.ok ? reconcile : null;
    const report: HealthReport = {
      status: failing === null ? 'ok' : 'failing',
      sha: deps.sha,
      migrations,
      rulesetVersion,
      sdkVersion: SDK_VERSION,
      reconcile,
    };
    if (failing !== null) c.get('logger').error('health: last reconcile failed', { failed: failing.failed, ranAt: failing.ranAt, source: failing.source });
    return ok(c, report, failing === null ? 200 : 503);
  });
}

async function activeRulesetVersion(db: Db): Promise<string | null> {
  const [row] = await db.select({ version: rulesets.version }).from(rulesets).where(eq(rulesets.active, true));
  return row?.version ?? null;
}
