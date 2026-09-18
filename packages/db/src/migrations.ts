import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import type { Sql } from './sql';

/**
 * Drizzle records applied migrations in `drizzle.__drizzle_migrations` and decides what to
 * apply by comparing each journal entry's folder timestamp against the newest recorded
 * `created_at`. `migrationState` mirrors that exact comparison so `/health` reports what
 * the migrator would actually do, not an approximation.
 */
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

export type MigrationState = {
  /** Rows in the migrations table. */
  applied: number;
  /** Entries in the migration folder's journal. */
  available: number;
  /** Journal entries newer than the last applied migration. Zero on a healthy deploy. */
  pending: number;
};

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

export async function readMigrationJournal(migrationsFolder: string): Promise<Journal> {
  const raw = await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
  return JSON.parse(raw) as Journal;
}

export async function migrationState(sql: Sql, migrationsFolder: string): Promise<MigrationState> {
  const journal = await readMigrationJournal(migrationsFolder);

  const [exists] = await sql<Array<{ present: boolean }>>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (!exists?.present) {
    return { applied: 0, available: journal.entries.length, pending: journal.entries.length };
  }

  const [row] = await sql<Array<{ applied: number; last: string | null }>>`
    select count(*)::int as applied, max(created_at)::text as last
    from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}
  `;
  const applied = row?.applied ?? 0;
  const lastAppliedMillis = row?.last === null || row?.last === undefined ? -1 : Number(row.last);
  const pending = journal.entries.filter((entry) => entry.when > lastAppliedMillis).length;

  return { applied, available: journal.entries.length, pending };
}

/**
 * Apply every pending migration, forward only. Any failure throws; callers exit non-zero
 * so a deploy with a broken migration never starts serving.
 */
export async function runMigrations(sql: Sql, migrationsFolder: string): Promise<MigrationState> {
  await migrate(drizzle(sql), { migrationsFolder, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE });
  return migrationState(sql, migrationsFolder);
}
