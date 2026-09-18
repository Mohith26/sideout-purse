import { Hono } from 'hono';
import { SDK_VERSION } from '@purse/sdk';
import { migrationState, type MigrationState, type Sql } from '@repo/db';

import { ApiFailure, ok } from '../http/envelope';
import type { RequestScope } from '../http/request-id';
import type { LastReconcile, ReconcileTracker } from '../ledger';

/**
 * `GET /health`, spec 4.7 and section 10: commit sha, migration state, active ruleset
 * version, SDK version, last reconcile result. `rulesetVersion` arrives with the
 * eligibility engine (phase 3) and is `null` until then rather than absent, so the shape
 * is stable for uptime checks. `lastReconcile` is this process's memory of its most
 * recent `reconcile()` run, `null` before the first.
 *
 * The response never includes a connection string, a key, or a hostname.
 */
export type HealthReport = {
  sha: string;
  migrations: MigrationState;
  rulesetVersion: string | null;
  sdkVersion: string;
  lastReconcile: LastReconcile | null;
};

export type HealthDeps = {
  sql: Sql;
  migrationsFolder: string;
  sha: string;
  tracker: ReconcileTracker;
};

export function healthRoutes(deps: HealthDeps) {
  return new Hono<RequestScope>().get('/health', async (c) => {
    let migrations: MigrationState;
    try {
      migrations = await migrationState(deps.sql, deps.migrationsFolder);
    } catch (error) {
      c.get('logger').error('health: database unreachable', { reason: error instanceof Error ? error.message : String(error) });
      throw new ApiFailure(
        { type: 'internal_error', code: 'database_unavailable', message: 'Database is unreachable' },
        503,
      );
    }

    const report: HealthReport = {
      sha: deps.sha,
      migrations,
      rulesetVersion: null,
      sdkVersion: SDK_VERSION,
      lastReconcile: deps.tracker.last(),
    };
    return ok(c, report);
  });
}
