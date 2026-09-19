import { sql } from 'drizzle-orm';

import type { Db } from './client';

/**
 * The nightly demo reset's Purse half (spec section 10: "reseeds the public demo to a
 * known good state"). Run as `purse_migrator`, the only role that may delete anything:
 * every row the demo produces is removed and the seed is applied again on the empty
 * tables (`scripts/demo-reset.ts`). What stays is the tenant's configuration and the
 * platform's own record, none of which the demo changes and all of which a running
 * deploy depends on:
 *
 *   tenants, tenant_origins        the Sideout tenant and its allowed browser origins
 *   api_keys                       Sideout's keys; the deployed Sideout holds one of them
 *   webhook_endpoints              where Purse delivers to, and the secret Sideout verifies with
 *   rulesets                       the active ruleset (the seed re-publishes it if absent)
 *   operators, operator_sessions   the console's accounts
 *   reconcile_runs                 the invariant record; a reset is not a reason to forget a failure
 *
 * Everything else, the journal included, is demo data: the users, their wallets and
 * balances, the contests and their results, the deliveries, the decisions and the audit
 * trail of all of it. The order is foreign-key order, the same as the test fixtures'.
 * Refuses a database whose name does not say it is a demo (`purse` or `purse_demo*`), so
 * a connection string for anything else is not one reset away from empty.
 */
export const DEMO_DATA_TABLES = [
  'webhook_delivery_attempts',
  'webhook_deliveries',
  'embed_signin_codes',
  'embed_tokens',
  'eligibility_decisions',
  'operator_flags',
  'identity_fingerprints',
  'user_locations',
  'user_restrictions',
  'contest_results',
  'contest_scores',
  'contest_participants',
  'journal_lines',
  'journal_entries',
  'contests',
  'idempotency_keys',
  'idempotency_reservations',
  'audit_log',
  'accounts',
  'user_verification',
  'users',
] as const;

export const KEPT_TABLES = ['tenants', 'tenant_origins', 'api_keys', 'webhook_endpoints', 'rulesets', 'operators', 'operator_sessions', 'reconcile_runs'] as const;

const DEMO_DATABASE = /^purse(_demo.*|_test|_p\d+.*)?$/;

export type DemoResetSummary = { database: string; deleted: Record<string, number> };

export async function assertDemoDatabase(db: Db): Promise<string> {
  const [row] = await db.execute<{ name: string }>(sql`select current_database()::text as name`);
  const name = row?.name ?? '';
  if (!DEMO_DATABASE.test(name)) throw new Error(`Refusing to reset database "${name}": the demo reset only runs against a database named purse, purse_demo* or a test database`);
  return name;
}

/** Delete every demo row, in one transaction, and say how many of each. */
export async function clearDemoData(db: Db): Promise<DemoResetSummary> {
  const database = await assertDemoDatabase(db);
  const deleted: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const table of DEMO_DATA_TABLES) {
      const result = await tx.execute(sql.raw(`delete from public."${table}"`));
      deleted[table] = Number(result.count ?? 0);
    }
  });
  return { database, deleted };
}
