/**
 * Purse schema, system spec section 4.1. Phase 0 ships tenancy and the audit log; later
 * phases add identity, contests and the ledger in this file and generate migrations from
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
import { index, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { idCheck, timestamps } from '@repo/db';

// ---- Tenancy -------------------------------------------------------------------------

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);

/** One row per partner application. Sideout is the first; see `SIDEOUT_TENANT_ID`. */
export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: tenantStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [idCheck('tenants_id_prefix', table.id, 'tnt')],
);

// ---- Audit ---------------------------------------------------------------------------

/**
 * Who caused a change. `system` is Purse itself (migrations, schedulers); `operator` is a
 * human in the console; `tenant` is a partner's server acting with a secret key; `user` is
 * an end user acting through the embed.
 */
export const actorKind = pgEnum('actor_kind', ['system', 'operator', 'tenant', 'user']);

/**
 * Every state transition, with actor, subject, and before/after snapshots (spec 4.1). The
 * table is append-only by contract; phase 1 revokes UPDATE and DELETE from `purse_app` on
 * this table together with the journal tables.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    /** Null for platform-level events that belong to no tenant. */
    tenantId: text('tenant_id').references(() => tenants.id),
    actorKind: actorKind('actor_kind').notNull(),
    /** Operator id, api key id, user id, or job name, depending on `actor_kind`. */
    actorRef: text('actor_ref'),
    /** Dotted verb, e.g. `tenant.created`, `contest.transitioned`. */
    action: text('action').notNull(),
    /** Table or aggregate the subject lives in, e.g. `tenant`, `contest`. */
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    /** `X-Request-Id` of the request that caused the change, when there was one. */
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('audit_log_id_prefix', table.id, 'aud'),
    index('audit_log_subject_idx').on(table.subjectKind, table.subjectId, table.createdAt),
    index('audit_log_tenant_created_idx').on(table.tenantId, table.createdAt),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type AuditEvent = typeof auditLog.$inferSelect;
export type NewAuditEvent = typeof auditLog.$inferInsert;
