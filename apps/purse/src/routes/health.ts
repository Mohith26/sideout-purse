import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SDK_VERSION } from '@purse/sdk';
import { migrationState, type MigrationState, type Sql } from '@repo/db';

import type { Db } from '../db/client';
import { rulesets } from '../db/schema';
import { ApiFailure, ok } from '../http/envelope';
import type { RequestScope } from '../http/request-id';

/**
 * `GET /health` (also at `/v1/health`), spec 4.7: commit sha, migration state, active
 * ruleset version, SDK version. `rulesetVersion` is the active `rulesets` row's version,
 * `null` on a database that has been migrated but not seeded, so the shape is stable for
 * uptime checks. The last reconcile result (spec section 10) joins the report in phase 9
 * with the scheduled reconcile job that records it (docs/decisions.md).
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
  db: Db;
  migrationsFolder: string;
  sha: string;
};

export function healthRoutes(deps: HealthDeps) {
  return new Hono<RequestScope>().get('/health', async (c) => {
    let migrations: MigrationState;
    let rulesetVersion: string | null;
    try {
      migrations = await migrationState(deps.sql, deps.migrationsFolder);
      rulesetVersion = migrations.pending === 0 ? await activeRulesetVersion(deps.db) : null;
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
      rulesetVersion,
      sdkVersion: SDK_VERSION,
    };
    return ok(c, report);
  });
}

async function activeRulesetVersion(db: Db): Promise<string | null> {
  const [row] = await db.select({ version: rulesets.version }).from(rulesets).where(eq(rulesets.active, true));
  return row?.version ?? null;
}
