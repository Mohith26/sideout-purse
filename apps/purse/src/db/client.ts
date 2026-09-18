import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { closeSql, createSql, type Sql } from '@repo/db';

import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

/** A transaction opened on `Db`. Nested `transaction()` calls become savepoints. */
export type Tx = PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

/**
 * What the ledger service accepts: the database, or a transaction the caller already
 * holds so an entry posts atomically with the caller's own writes (a contest entry row
 * and its escrow entry, in phase 2). Both expose `transaction()`.
 */
export type DbOrTx = PgDatabase<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type Database = {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
};

export type ConnectOptions = {
  max?: number;
  /** Shown in `pg_stat_activity`; defaults to the API's name. Scripts pass their own. */
  applicationName?: string;
};

/** Open Purse's database. The caller supplies the URL from `env()`; nothing else knows it. */
export function connect(databaseUrl: string, options: ConnectOptions = {}): Database {
  const sql = createSql(databaseUrl, {
    applicationName: options.applicationName ?? 'purse-api',
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { sql, db, close: () => closeSql(sql) };
}
