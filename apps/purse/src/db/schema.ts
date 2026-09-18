/**
 * Purse schema, system spec section 4.1. Phase 0 ships tenancy; later phases add the
 * audit log, identity, contests and the ledger in this file and generate migrations from
 * it with `pnpm db:generate`.
 *
 * Conventions every later table follows:
 *
 * - Ids are typed-prefix UUID v7 strings from `@repo/ids`, stored as `text` with a CHECK
 *   on the prefix (see `idCheck`). Never serial integers, never bare UUIDs.
 * - Timestamps are `timestamptz`, never `timestamp`. Defaults use `now()`.
 * - Amounts are `bigint` minor units in an explicit `asset` column (`POINTS` | `CREDIT`),
 *   read into JavaScript as `bigint` (`mode: 'bigint'`), never `number`. There are no
 *   floats anywhere in the money path, and no `USD` asset exists in Purse at all
 *   (spec 4.2.6). A line's `amount` is strictly positive; `direction` carries the sign.
 * - Column names are snake_case; drizzle's `casing: 'snake_case'` maps camelCase fields.
 * - Enumerations are Postgres enums, not free text, so the database rejects a typo.
 */
import { pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idCheck, timestamps } from '@repo/db';

// ---- Tenancy -------------------------------------------------------------------------

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);

/**
 * One row per partner application. Sideout is the first, upserted by `pnpm db:seed`
 * (`src/db/seed.ts`) rather than by a migration; names are unique so that upsert has a key.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: tenantStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [idCheck('tenants_id_prefix', table.id, 'tnt'), uniqueIndex('tenants_name_key').on(table.name)],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
