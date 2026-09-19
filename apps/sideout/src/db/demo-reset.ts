import { sql } from 'drizzle-orm';

import type { Db } from './client';

/**
 * The nightly demo reset's Sideout half: every table emptied, then the seed written
 * again and mirrored to a freshly reset Purse (`scripts/demo-reset.ts`). Sideout has one
 * role, which owns its tables, so a plain truncate does it. Nothing is kept: every row
 * Sideout holds is demo data (the seed recreates the organizers, the events and the
 * Purse links; the Purse contest columns are refilled by the walk). Refuses a database
 * whose name does not say it is a demo (`sideout` or `sideout_demo*`), so a connection
 * string for anything else is not one reset away from empty.
 */
export const ALL_TABLES = [
  'audit_log',
  'purse_calls',
  'purse_webhook_events',
  'purse_entries',
  'score_submissions',
  'match_consensus',
  'donation_provider_events',
  'donations',
  'sets',
  'matches',
  'pool_teams',
  'pools',
  'team_devices',
  'team_members',
  'teams',
  'sponsors',
  'tournaments',
  'auth_codes',
  'users',
  'charities',
] as const;

const DEMO_DATABASE = /^sideout(_demo.*|_test|_p\d+.*)?$/;

export async function assertDemoDatabase(db: Db): Promise<string> {
  const [row] = await db.execute<{ name: string }>(sql`select current_database()::text as name`);
  const name = row?.name ?? '';
  if (!DEMO_DATABASE.test(name)) throw new Error(`Refusing to reset database "${name}": the demo reset only runs against a database named sideout, sideout_demo* or a test database`);
  return name;
}

/** Empty every table in one statement. */
export async function clearAllData(db: Db): Promise<{ database: string; tables: number }> {
  const database = await assertDemoDatabase(db);
  await db.execute(sql.raw(`truncate table ${ALL_TABLES.map((table) => `public."${table}"`).join(', ')} restart identity cascade`));
  return { database, tables: ALL_TABLES.length };
}
