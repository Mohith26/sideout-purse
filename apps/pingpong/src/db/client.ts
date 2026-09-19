import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { closeSql, createSql, type Sql } from '@repo/db';

import { env } from '../env';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type Database = {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
};

/** Open a connection pool to the ladder's database with an explicit URL (scripts, tests). */
export function connect(databaseUrl: string, options: { max?: number } = {}): Database {
  const sql = createSql(databaseUrl, { applicationName: 'pingpong-web', ...options });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { sql, db, close: () => closeSql(sql) };
}

/** The process-wide pool used by pages and route handlers; cached on `globalThis` so `next dev` keeps one. */
const globalPool = globalThis as typeof globalThis & { __pingpongDatabase?: Database };

export function database(): Database {
  globalPool.__pingpongDatabase ??= connect(env().databaseUrl);
  return globalPool.__pingpongDatabase;
}
