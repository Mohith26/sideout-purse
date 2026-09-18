import { existsSync } from 'node:fs';
import path from 'node:path';

import { runMigrations } from '@repo/db';

import { connect } from '../src/db/client';
import { loadEnv, requireMigratorUrl } from '../src/env';
import { MIGRATIONS_FOLDER } from '../src/paths';

/**
 * Bring the test database to a known state once per run: wipe it and apply every
 * migration, as `purse_migrator`, the only role that may. Individual tests then read a
 * fully migrated, otherwise empty, schema through the runtime role.
 */
export default async function globalSetup(): Promise<void> {
  const envFile = path.resolve(import.meta.dirname, '../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadEnv({ ...process.env, NODE_ENV: 'test' });
  const database = connect(requireMigratorUrl(config), { max: 1, applicationName: 'purse-test-setup' });
  try {
    await resetDatabase(database.sql);
    await runMigrations(database.sql, MIGRATIONS_FOLDER);
  } finally {
    await database.close();
  }
}

/** Drop everything the app owns in the test database. Only ever pointed at `*_test`, only ever run as the owner. */
export async function resetDatabase(sql: Awaited<ReturnType<typeof connect>>['sql']): Promise<void> {
  const [row] = await sql<Array<{ current_database: string }>>`select current_database()`;
  const name = row?.current_database ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": test databases must end in _test`);
  }
  await sql.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
}
