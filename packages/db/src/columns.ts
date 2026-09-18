import { sql } from 'drizzle-orm';
import { check, timestamp, type PgColumn } from 'drizzle-orm/pg-core';
import { idCheckPattern, type IdPrefix } from '@repo/ids';

/**
 * Schema conventions both apps share (see each app's `db/schema.ts` header for the full
 * list). Ids are typed-prefix UUID v7 strings checked at the database, and every table
 * carries `timestamptz` created/updated columns.
 */

/**
 * CHECK constraint pinning an id column to one prefix, e.g. `CHECK (id ~ '^tnt_...')`.
 * The pattern is inlined as a SQL literal (not a bind parameter) because it has to appear
 * verbatim in the generated migration.
 */
export function idCheck(constraintName: string, column: PgColumn, prefix: IdPrefix) {
  const literal = `'${idCheckPattern(prefix).replaceAll("'", "''")}'`;
  return check(constraintName, sql`${column} ~ ${sql.raw(literal)}`);
}

/** `created_at` / `updated_at` as `timestamptz not null default now()`. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
