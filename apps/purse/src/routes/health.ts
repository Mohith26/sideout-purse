import { Hono } from 'hono';
import { SDK_VERSION } from '@purse/sdk';
import { migrationState, type MigrationState, type Sql } from '@repo/db';

import { ApiFailure, ok } from '../http/envelope';
import type { RequestScope } from '../http/request-id';

/**
 * `GET /health`, spec 4.7: commit sha, migration state, active ruleset version, SDK
 * version. `rulesetVersion` arrives with the eligibility engine (phase 3) and is `null`
 * until then rather than absent, so the shape is stable for uptime checks. The last
 * reconcile result (spec section 10) joins the report in phase 9 with the scheduled
 * reconcile job that records it (docs/decisions.md).
 *
 * The response never includes a connection string, a key, or a hostname.
 */
export type HealthReport = {
  sha: string;
  migrations: MigrationState;
  rulesetVersion: string | null;
  sdkVersion: string;
};

export type HealthDeps = {
  sql: Sql;
  migrationsFolder: string;
  sha: string;
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
    };
    return ok(c, report);
  });
}
