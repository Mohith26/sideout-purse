import { sql } from 'drizzle-orm';
import { check, timestamp, type PgColumn } from 'drizzle-orm/pg-core';
import { idCheckPattern, type IdPrefix } from '@repo/ids';

/**
 * Schema conventions both apps share (see each app's `db/schema.ts` header for the full
 * list). Ids are typed-prefix UUID v7 strings checked at the database, and every table
 * carries `timestamptz` created/updated columns.
 */

/**
 * The prefix pattern as a SQL literal (not a bind parameter) because it has to appear
 * verbatim in the generated migration. Exported for CHECKs that mention a prefix inside a
 * larger expression, so the pattern is never restated by hand.
 */
export function idPatternLiteral(prefix: IdPrefix) {
  return sql.raw(`'${idCheckPattern(prefix).replaceAll("'", "''")}'`);
}

/** CHECK constraint pinning an id column to one prefix, e.g. `CHECK (id ~ '^tnt_...')`. */
export function idCheck(constraintName: string, column: PgColumn, prefix: IdPrefix) {
  return check(constraintName, sql`${column} ~ ${idPatternLiteral(prefix)}`);
}

/**
 * The same check for a nullable reference column: NULL passes, anything else must carry
 * the prefix. Used where the referenced table does not exist yet (a later phase adds the
 * foreign key) so a mis-typed id is still refused today.
 */
export function nullableIdCheck(constraintName: string, column: PgColumn, prefix: IdPrefix) {
  return check(constraintName, sql`${column} is null or ${column} ~ ${idPatternLiteral(prefix)}`);
}

/** `created_at` / `updated_at` as `timestamptz not null default now()`. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
