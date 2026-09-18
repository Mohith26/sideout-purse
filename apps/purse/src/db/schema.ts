/**
 * Purse schema, system spec section 4.1. Phase 0 shipped tenancy; phase 1 adds the ledger
 * (4.2) and the audit log. Later phases add identity, contests and plumbing in this file
 * and generate migrations from it with `pnpm db:generate`.
 *
 * Conventions every table follows:
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
 * - Privileges are explicit. Tables are owned by `purse_migrator`; the runtime role
 *   `purse_app` gets exactly what it needs per table in a custom migration (see
 *   `drizzle/0002_ledger_roles.sql` and `0004_ledger_guards.sql`). A new table with no
 *   grant is unreadable by the runtime, which `test/ledger/roles.test.ts` turns into a
 *   failing test rather than a surprise in production. Append-only tables (the journal,
 *   the audit log) never grant UPDATE, DELETE or TRUNCATE; tables a balance depends on
 *   (`accounts`, `tenants`) grant UPDATE on `status` and `updated_at` only.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idCheck, idPatternLiteral, nullableIdCheck, timestamps } from '@repo/db';

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

// ---- Ledger (spec 4.2) ---------------------------------------------------------------

/** The only two assets Purse knows (decision D3). `USD` is not, and must never be, one. */
export const asset = pgEnum('asset', ['POINTS', 'CREDIT']);
export type Asset = (typeof asset.enumValues)[number];

/** A side of the ledger. Used for an account's normal side and for a line's direction. */
export const ledgerSide = pgEnum('ledger_side', ['debit', 'credit']);
export type LedgerSide = (typeof ledgerSide.enumValues)[number];

export const accountKind = pgEnum('account_kind', [
  'user_wallet',
  'contest_escrow',
  'sponsor_funding',
  'promo_liability',
  'platform_fee',
  'external_settlement',
]);
export type AccountKind = (typeof accountKind.enumValues)[number];

/**
 * The normal side of each kind, verbatim from the spec 4.2.1 table. A CHECK on `accounts`
 * pins `normal_side` to this mapping so no code path can open, say, a debit-normal wallet.
 */
export const NORMAL_SIDE_BY_KIND: Readonly<Record<AccountKind, LedgerSide>> = {
  user_wallet: 'credit',
  contest_escrow: 'credit',
  sponsor_funding: 'debit',
  promo_liability: 'credit',
  platform_fee: 'credit',
  external_settlement: 'debit',
};

export const accountStatus = pgEnum('account_status', ['open', 'frozen', 'closed']);
export type AccountStatus = (typeof accountStatus.enumValues)[number];

/**
 * Spec 4.2.1. One account holds exactly one asset. `owner_ref` is the user id for a
 * wallet, the contest id for an escrow, and NULL for the platform-level accounts, which
 * makes each of those a singleton per (tenant, kind, asset): the unique constraint treats
 * NULLs as equal, so the database, not the seed script, guarantees there is one promo
 * liability account per asset.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: accountKind('kind').notNull(),
    ownerRef: text('owner_ref'),
    asset: asset('asset').notNull(),
    normalSide: ledgerSide('normal_side').notNull(),
    status: accountStatus('status').notNull().default('open'),
    ...timestamps,
  },
  (table) => [
    idCheck('accounts_id_prefix', table.id, 'acct'),
    unique('accounts_tenant_kind_owner_asset_key')
      .on(table.tenantId, table.kind, table.ownerRef, table.asset)
      .nullsNotDistinct(),
    // Target of the composite foreign key from `journal_lines`, which is how the database
    // itself guarantees a line's asset is its account's asset.
    unique('accounts_id_asset_key').on(table.id, table.asset),
    check(
      'accounts_normal_side_by_kind',
      sql`${table.normalSide} = (case ${table.kind}
        when 'user_wallet' then 'credit'
        when 'contest_escrow' then 'credit'
        when 'sponsor_funding' then 'debit'
        when 'promo_liability' then 'credit'
        when 'platform_fee' then 'credit'
        when 'external_settlement' then 'debit'
      end)::ledger_side`,
    ),
    // A wallet belongs to a user and an escrow to a contest; the platform accounts have no
    // owner. NULL is not a pass here: the CHECK is written so NULL evaluates false.
    check(
      'accounts_owner_ref_by_kind',
      sql`case ${table.kind}
        when 'user_wallet' then ${table.ownerRef} is not null and ${table.ownerRef} ~ ${idPatternLiteral('usr')}
        when 'contest_escrow' then ${table.ownerRef} is not null and ${table.ownerRef} ~ ${idPatternLiteral('cnt')}
        else true
      end`,
    ),
    index('accounts_tenant_id_idx').on(table.tenantId),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

/**
 * What an entry records. Phase 1 covers the 4.2.5 standard flows plus the two ways a
 * mistake is corrected (a plain reversal, or a void, which is a reversal too). Phase 2
 * adds what contests and settlement need with `ALTER TYPE ... ADD VALUE`.
 */
export const journalEntryKind = pgEnum('journal_entry_kind', [
  'issue',
  'escrow',
  'refund',
  'settle',
  'void',
  'reversal',
  'adjustment',
]);
export type JournalEntryKind = (typeof journalEntryKind.enumValues)[number];

/**
 * Spec 4.2.2. Append-only: the runtime role holds INSERT and SELECT and nothing else, so
 * there is no `updated_at`. `posted_at` is the ledger time every balance query bounds on;
 * the database sets it (`clock_timestamp()` once every lock is held, so per account it
 * follows commit order) and the service never passes one. Both times are stored at
 * millisecond precision, the precision of a JavaScript `Date`, so an entry's own
 * `posted_at` read back and passed to `balanceOf(asOf)` includes that entry exactly.
 * `request_hash` is what makes idempotency honest: a replay of the same key returns the
 * original only if the payload is the same, and a different payload under a used key is
 * a conflict. Keys are unique per tenant, not globally (docs/decisions.md): a partner's
 * key can never collide with, or reveal, another partner's entry.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: journalEntryKind('kind').notNull(),
    description: text('description').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    contestId: text('contest_id'),
    reversesEntryId: text('reverses_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('journal_entries_id_prefix', table.id, 'je'),
    nullableIdCheck('journal_entries_contest_id_prefix', table.contestId, 'cnt'),
    uniqueIndex('journal_entries_tenant_id_idempotency_key_key').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      name: 'journal_entries_reverses_entry_id_fk',
      columns: [table.reversesEntryId],
      foreignColumns: [table.id],
    }),
    // History is corrected once. A second reversal of the same entry would double the
    // correction, so the database refuses it outright.
    uniqueIndex('journal_entries_reverses_entry_id_key')
      .on(table.reversesEntryId)
      .where(sql`${table.reversesEntryId} is not null`),
    check('journal_entries_reversal_not_self', sql`${table.reversesEntryId} is null or ${table.reversesEntryId} <> ${table.id}`),
    index('journal_entries_tenant_id_posted_at_idx').on(table.tenantId, table.postedAt),
    index('journal_entries_contest_id_idx')
      .on(table.contestId)
      .where(sql`${table.contestId} is not null`),
  ],
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;

/**
 * Spec 4.2.2. `amount` is strictly positive at the database; `direction` carries the sign.
 * The composite foreign key on (`account_id`, `asset`) means a line can only ever carry
 * its account's asset. `sequence` orders lines within an entry and starts at 1.
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    accountId: text('account_id').notNull(),
    direction: ledgerSide('direction').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    asset: asset('asset').notNull(),
    sequence: integer('sequence').notNull(),
  },
  (table) => [
    idCheck('journal_lines_id_prefix', table.id, 'jl'),
    check('journal_lines_amount_positive', sql`${table.amount} > 0`),
    check('journal_lines_sequence_positive', sql`${table.sequence} >= 1`),
    unique('journal_lines_entry_id_sequence_key').on(table.entryId, table.sequence),
    foreignKey({
      name: 'journal_lines_account_id_asset_fk',
      columns: [table.accountId, table.asset],
      foreignColumns: [accounts.id, accounts.asset],
    }),
    index('journal_lines_account_id_idx').on(table.accountId),
    index('journal_lines_entry_id_idx').on(table.entryId),
  ],
);

export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;

// ---- Audit log (spec 4.1, plumbing) --------------------------------------------------

export const auditActorKind = pgEnum('audit_actor_kind', ['system', 'operator', 'tenant', 'user']);
export type AuditActorKind = (typeof auditActorKind.enumValues)[number];

/**
 * Every state transition outside the journal: who did it, to what, and the row before and
 * after. Money movements are not duplicated here; the journal is its own audit trail.
 * `subject` is the typed id of the row that changed (its prefix says what kind of thing it
 * is), or a stable name for something without a row. Append-only like the journal.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id),
    actorKind: auditActorKind('actor_kind').notNull(),
    actorRef: text('actor_ref'),
    action: text('action').notNull(),
    subject: text('subject').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('audit_log_id_prefix', table.id, 'aud'),
    index('audit_log_subject_idx').on(table.subject),
    index('audit_log_tenant_id_created_at_idx').on(table.tenantId, table.createdAt),
  ],
);

export type AuditRow = typeof auditLog.$inferSelect;
export type NewAuditRow = typeof auditLog.$inferInsert;
