import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { closeSql, createSql, type Sql } from '@repo/db';

import { env } from '../env';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export type Database = {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
};

/** Open a connection pool to Sideout's database with an explicit URL (scripts, tests). */
export function connect(databaseUrl: string, options: { max?: number } = {}): Database {
  const sql = createSql(databaseUrl, { applicationName: 'sideout-web', ...options });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { sql, db, close: () => closeSql(sql) };
}

/**
 * The process-wide pool used by pages and route handlers. Cached on `globalThis` so hot
 * reloading in `next dev` does not open a new pool on every edit.
 */
const globalPool = globalThis as typeof globalThis & { __sideoutDatabase?: Database };

export function database(): Database {
  globalPool.__sideoutDatabase ??= connect(env().databaseUrl);
  return globalPool.__sideoutDatabase;
}
