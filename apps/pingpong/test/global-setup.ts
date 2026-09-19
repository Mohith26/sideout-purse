import { existsSync } from 'node:fs';
import path from 'node:path';

import { runMigrations, type Sql } from '@repo/db';

import { connect } from '../src/db/client';
import { loadEnv } from '../src/env';
import { migrationsFolder } from '../src/paths';

/** Wipe the test database and apply every migration once per run. */
export default async function globalSetup(): Promise<void> {
  const envFile = path.resolve(import.meta.dirname, '../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.env['PINGPONG_DATABASE_URL_TEST'] ??= 'postgres://pingpong_app:pingpong_app@localhost:5432/pingpong_test';

  const config = loadEnv({ ...process.env, NODE_ENV: 'test' });
  const database = connect(config.databaseUrl, { max: 1 });
  try {
    await resetDatabase(database.sql);
    await runMigrations(database.sql, migrationsFolder());
  } finally {
    await database.close();
  }
}

/** Drop everything the app owns in the test database. Only ever pointed at `*_test`. */
export async function resetDatabase(sql: Sql): Promise<void> {
  const [row] = await sql<Array<{ current_database: string }>>`select current_database()`;
  const name = row?.current_database ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": test databases must end in _test`);
  }
  await sql.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
}
