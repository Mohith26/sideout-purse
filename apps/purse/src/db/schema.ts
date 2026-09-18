/**
 * Purse schema, system spec section 4.1. Phase 0 shipped tenancy; phase 1 added the ledger
 * (4.2) and the audit log; phase 2 adds contests, entries, scores, results and the
 * idempotency-key record. Later phases add identity and plumbing in this file and generate
 * migrations from it with `pnpm db:generate`.
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
 *   `drizzle/0002_ledger_roles.sql`, `0004_ledger_guards.sql` and
 *   `0006_contest_guards.sql`). A new table with no grant is unreadable by the runtime,
 *   which `test/ledger/roles.test.ts` turns into a failing test rather than a surprise in
 *   production. Append-only tables (the journal, the audit log, contest results, used
 *   idempotency keys) never grant UPDATE, DELETE or TRUNCATE; other tables grant UPDATE
 *   on exactly the columns that legitimately change (`accounts`, `tenants`: `status` and
 *   `updated_at`; see each contest table's note).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idCheck, idPatternLiteral, nullableIdCheck, timestamps } from '@repo/db';

import { TIE_BREAK_RULES, type PrizeStructure } from '../settlement/types';

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
 * What an entry records: the 4.2.5 standard flows plus the two ways a mistake is corrected
 * (a plain reversal, or a void, which is a reversal too). Contests use `escrow` for an
 * entry, `refund` for a withdrawal before lock, `settle` for the one settlement entry and
 * `void` for each refund of a voided contest; a later kind is added with
 * `ALTER TYPE ... ADD VALUE`.
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
 * key can never collide with, or reveal, another partner's entry. `contest_id` is a real
 * foreign key from phase 2 on: an entry cannot claim a contest that does not exist.
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
    contestId: text('contest_id').references(() => contests.id),
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

// ---- Contests (spec 4.1, 4.3, 4.4) ---------------------------------------------------

export const contestKind = pgEnum('contest_kind', ['tournament', 'head_to_head', 'pool']);
export type ContestKind = (typeof contestKind.enumValues)[number];

/** Decision D6: both settlement triggers exist; `operator_close` is the default and what every Sideout tournament ships on. */
export const settlementPolicy = pgEnum('settlement_policy', ['operator_close', 'auto']);
export type SettlementPolicy = (typeof settlementPolicy.enumValues)[number];

/** Spec 4.3. Only `transition()` in `src/contests/transition.ts` ever writes this column. */
export const contestState = pgEnum('contest_state', [
  'draft',
  'open',
  'locked',
  'in_progress',
  'awaiting_settlement',
  'settling',
  'settled',
  'cancelled',
  'voided',
]);
export type ContestState = (typeof contestState.enumValues)[number];

export const participantState = pgEnum('participant_state', ['entered', 'withdrawn', 'disqualified']);
export type ParticipantState = (typeof participantState.enumValues)[number];

/** Spec 4.4 rule 4. The list lives with the settlement engine; the enum mirrors it so the database rejects a rule the engine does not know. */
export const tieBreakRule = pgEnum('tie_break_rule', TIE_BREAK_RULES);

/**
 * Spec 4.1. A contest is created in `draft` with its escrow account already open; the
 * composite foreign key on (`escrow_account_id`, `asset`) is the same trick `journal_lines`
 * uses, so the escrow can only ever hold the contest's own asset. `prize_structure` is
 * validated by `prizeStructureSchema` (`src/settlement/types.ts`) before it is stored and
 * again by `settle` when it is used. `entry_amount` is strictly positive: every entry
 * escrows something, which is what lets I7 hold for every participant.
 *
 * Once a contest leaves `draft` the fields that define it are frozen by a trigger
 * (`drizzle/0006_contest_guards.sql`), and the runtime role may update only `state`,
 * `settled_at`, `locks_at`, the draft-editable fields and `updated_at`; it can never
 * touch `asset`, `tenant_id`, `escrow_account_id` or `external_id`.
 */
export const contests = pgTable(
  'contests',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The partner's opaque id for this contest, unique per tenant (spec 4.1). */
    externalId: text('external_id').notNull(),
    kind: contestKind('kind').notNull(),
    title: text('title').notNull(),
    asset: asset('asset').notNull(),
    entryAmount: bigint('entry_amount', { mode: 'bigint' }).notNull(),
    maxParticipants: integer('max_participants'),
    prizeStructure: jsonb('prize_structure').$type<PrizeStructure>().notNull(),
    tieBreak: tieBreakRule('tie_break').notNull().default('split_evenly'),
    settlementPolicy: settlementPolicy('settlement_policy').notNull().default('operator_close'),
    /** Set by the eligibility engine (phase 3); `null` until a ruleset exists. */
    eligibilityRulesetVersion: text('eligibility_ruleset_version'),
    state: contestState('state').notNull().default('draft'),
    opensAt: timestamp('opens_at', { withTimezone: true }),
    /** After this instant no entry is accepted even while the state is still `open`. */
    locksAt: timestamp('locks_at', { withTimezone: true }),
    escrowAccountId: text('escrow_account_id').notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    idCheck('contests_id_prefix', table.id, 'cnt'),
    unique('contests_tenant_id_external_id_key').on(table.tenantId, table.externalId),
    // One contest per escrow account, and the escrow's asset is the contest's asset.
    unique('contests_escrow_account_id_key').on(table.escrowAccountId),
    foreignKey({
      name: 'contests_escrow_account_id_asset_fk',
      columns: [table.escrowAccountId, table.asset],
      foreignColumns: [accounts.id, accounts.asset],
    }),
    check('contests_entry_amount_positive', sql`${table.entryAmount} > 0`),
    check('contests_max_participants_positive', sql`${table.maxParticipants} is null or ${table.maxParticipants} >= 1`),
    check('contests_external_id_not_blank', sql`length(trim(${table.externalId})) > 0`),
    // `settled_at` is set exactly when the contest is settled, never before and never on any other terminal state.
    check('contests_settled_at_iff_settled', sql`(${table.state} = 'settled') = (${table.settledAt} is not null)`),
    index('contests_tenant_id_state_idx').on(table.tenantId, table.state),
  ],
);

export type Contest = typeof contests.$inferSelect;
export type NewContest = typeof contests.$inferInsert;

/**
 * Spec 4.1: one row per user per contest, ever. `entry_journal_entry_id` is the escrow entry
 * that currently holds the stake (I7 checks it debits this user's wallet and credits this
 * contest's escrow for the contest's asset and amount) and is unique: one stake, one entry.
 * A withdrawal marks the row `withdrawn` and refunds through a separate `refund` entry; a
 * withdrawn user may enter again while the contest is open, which reactivates this same
 * row with a fresh escrow entry (docs/decisions.md). `seed` and `team_ref` are set at the
 * first entry and never change; `seed` feeds the `higher_seed_wins` tie-break (lower is
 * better).
 */
export const contestParticipants = pgTable(
  'contest_participants',
  {
    id: text('id').primaryKey(),
    contestId: text('contest_id')
      .notNull()
      .references(() => contests.id),
    userId: text('user_id').notNull(),
    /** The partner's opaque team reference, if the entrant plays as part of a team. */
    teamRef: text('team_ref'),
    seed: integer('seed'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    entryJournalEntryId: text('entry_journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    state: participantState('state').notNull().default('entered'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('contest_participants_id_prefix', table.id, 'ent'),
    idCheck('contest_participants_user_id_prefix', table.userId, 'usr'),
    unique('contest_participants_contest_id_user_id_key').on(table.contestId, table.userId),
    unique('contest_participants_entry_journal_entry_id_key').on(table.entryJournalEntryId),
    check('contest_participants_seed_positive', sql`${table.seed} is null or ${table.seed} >= 1`),
    index('contest_participants_contest_id_state_idx').on(table.contestId, table.state),
  ],
);

export type ContestParticipant = typeof contestParticipants.$inferSelect;
export type NewContestParticipant = typeof contestParticipants.$inferInsert;

/**
 * Spec 4.1: append-only. A new score for the same user supersedes the previous one by
 * setting `superseded_by` on the old row, the only column the runtime may update, and
 * only once (a trigger refuses a second supersession and refuses superseding a row whose
 * `attempt_finished` is true; see docs/decisions.md). One counting score per user per
 * contest at any moment is a deferrable exclusion constraint on (`contest_id`, `user_id`)
 * where `superseded_by is null`, checked at commit so the new row can exist before the
 * old one points at it (`drizzle/0006_contest_guards.sql`; drizzle cannot express it).
 * `score` is not money: it orders entrants and nothing else, so `numeric` read as a
 * JavaScript number is fine here.
 */
export const contestScores = pgTable(
  'contest_scores',
  {
    id: text('id').primaryKey(),
    contestId: text('contest_id')
      .notNull()
      .references(() => contests.id),
    userId: text('user_id').notNull(),
    score: numeric('score', { mode: 'number' }),
    attemptFinished: boolean('attempt_finished').notNull().default(false),
    /** Set by the service to `clock_timestamp()` after the contest lock is held, so per contest it follows submission order. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    /** The partner's reference for where this score came from (a match id, a consensus record). */
    sourceRef: text('source_ref'),
    supersededBy: text('superseded_by'),
  },
  (table) => [
    idCheck('contest_scores_id_prefix', table.id, 'sco'),
    idCheck('contest_scores_user_id_prefix', table.userId, 'usr'),
    foreignKey({ name: 'contest_scores_superseded_by_fk', columns: [table.supersededBy], foreignColumns: [table.id] }),
    check('contest_scores_not_self_superseded', sql`${table.supersededBy} is null or ${table.supersededBy} <> ${table.id}`),
    index('contest_scores_contest_id_user_id_idx').on(table.contestId, table.userId),
  ],
);

export type ContestScore = typeof contestScores.$inferSelect;
export type NewContestScore = typeof contestScores.$inferInsert;

/**
 * Spec 4.1: written once, at settlement, inside the settlement transaction, one row per
 * entrant the engine placed. `payout_journal_entry_id` is the single `settle` entry that
 * paid every winner, or `null` on a row whose payout is zero (a journal line cannot be
 * zero). I5 sums `payout_amount` against what the contest escrowed. Append-only: the
 * runtime holds INSERT and SELECT and nothing else.
 */
export const contestResults = pgTable(
  'contest_results',
  {
    id: text('id').primaryKey(),
    contestId: text('contest_id')
      .notNull()
      .references(() => contests.id),
    userId: text('user_id').notNull(),
    placement: integer('placement').notNull(),
    score: numeric('score', { mode: 'number' }),
    payoutAmount: bigint('payout_amount', { mode: 'bigint' }).notNull(),
    payoutJournalEntryId: text('payout_journal_entry_id').references(() => journalEntries.id),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('contest_results_id_prefix', table.id, 'res'),
    idCheck('contest_results_user_id_prefix', table.userId, 'usr'),
    unique('contest_results_contest_id_user_id_key').on(table.contestId, table.userId),
    check('contest_results_placement_positive', sql`${table.placement} >= 1`),
    check('contest_results_payout_non_negative', sql`${table.payoutAmount} >= 0`),
    check('contest_results_zero_payout_has_no_entry', sql`(${table.payoutAmount} > 0) = (${table.payoutJournalEntryId} is not null)`),
    index('contest_results_contest_id_idx').on(table.contestId),
  ],
);

export type ContestResult = typeof contestResults.$inferSelect;
export type NewContestResult = typeof contestResults.$inferInsert;

// ---- Idempotency keys (spec 4.1, plumbing) -------------------------------------------

/**
 * Spec 4.1 `idempotency_keys`, the record behind "every Purse mutation is idempotent"
 * (spec section 2, rule 4) for the mutations that are not themselves a journal entry. One
 * row per (tenant, key): the operation it was used for, a hash of the request, and the
 * ids the operation produced, from which a replay reloads and returns the original result
 * (`src/contests/idempotency.ts`). A different request under a used key is a conflict.
 * Append-only for the runtime; the 30-day TTL purge (spec 4.1) is a phase 9 job that runs
 * as the owner.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [table.tenantId, table.key] }),
    index('idempotency_keys_created_at_idx').on(table.createdAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
