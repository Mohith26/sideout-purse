import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { closeSql, createSql, type Sql } from '@repo/db';

import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export type Database = {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
};

/** Open Purse's database. The caller supplies the URL from `env()`; nothing else knows it. */
export function connect(databaseUrl: string, options: { max?: number } = {}): Database {
  const sql = createSql(databaseUrl, { applicationName: 'purse-api', ...options });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { sql, db, close: () => closeSql(sql) };
}
