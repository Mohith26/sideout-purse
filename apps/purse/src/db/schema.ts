/**
 * Purse schema, system spec section 4.1. Phase 0 shipped tenancy; phase 1 added the ledger
 * (4.2) and the audit log; phase 2 added contests, entries, scores, results and the
 * idempotency-key record; phase 3 adds identity (users, verification, restrictions,
 * locations), the eligibility engine's stored rulesets and decisions (4.5), the risk
 * tables (4.6: identity fingerprints and operator flags), API keys and embed tokens;
 * phase 4 adds the embed's origin allowlist and sign-in codes (4.8) and the webhook
 * endpoints, deliveries and attempts (4.9); phase 5 adds the operator console's accounts
 * and sessions (4.10); phase 9 adds the record of every reconcile run (section 10, the
 * last result `/health` reports). Later phases add plumbing in this file and generate
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
 *   `drizzle/0002_ledger_roles.sql`, `0004_ledger_guards.sql`, `0006_contest_guards.sql`,
 *   `0008_identity_guards.sql`, `0010_idempotency_reservation_grants.sql`,
 *   `0012_embed_webhook_guards.sql`, `0014_operator_guards.sql` and
 *   `0016_reconcile_run_grants.sql`). A new table with no grant is unreadable by the runtime,
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
  date,
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
import type { AttestationState, EligibilityReason, EcPublicJwk, RequiredAction, ScoreAttestationResource, WebhookEventType } from '@purse/types';
import { idCheck, idPatternLiteral, nullableIdCheck, timestamps } from '@repo/db';

import type { Ruleset } from '../eligibility/ruleset';
import type { ReconcileReport } from '../ledger/reconcile';
import { TIE_BREAK_RULES, type PrizeStructure } from '../settlement/types';

// ---- Tenancy -------------------------------------------------------------------------

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended', 'retired']);
export type TenantStatus = (typeof tenantStatus.enumValues)[number];

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

/** Immutable self-serve lease and mint replay receipt; absence means a managed tenant. */
export const sandboxLeases = pgTable('sandbox_leases', {
  tenantId: text('tenant_id').primaryKey().references(() => tenants.id),
  address: text('address').notNull(),
  requestKey: text('request_key').notNull(),
  origin: text('origin').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('sandbox_leases_request_idx').on(table.address, table.requestKey),
  index('sandbox_leases_expiry_idx').on(table.expiresAt),
]);

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
    /**
     * The owner as a real foreign key, for wallets: equal to `owner_ref` when `kind` is
     * `user_wallet` and null otherwise (the CHECK below). Postgres cannot make `owner_ref`
     * itself a conditional foreign key, so the wallet's owner is named twice and the
     * database holds the two equal; a wallet for a user that does not exist is refused.
     */
    userId: text('user_id').references(() => users.id),
    asset: asset('asset').notNull(),
    normalSide: ledgerSide('normal_side').notNull(),
    status: accountStatus('status').notNull().default('open'),
    ...timestamps,
  },
  (table) => [
    idCheck('accounts_id_prefix', table.id, 'acct'),
    check(
      'accounts_user_id_is_wallet_owner',
      sql`(${table.kind} = 'user_wallet') = (${table.userId} is not null) and (${table.userId} is null or ${table.userId} = ${table.ownerRef})`,
    ),
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
  // Treasury (spec section 14). `deposit` and `withdrawal` are the in-ledger leg of a
  // payment on the fiat rail; `fee` is the platform's rake, taken off a contest's escrow
  // immediately before it settles so the settle entry only ever distributes the net pool.
  'deposit',
  'withdrawal',
  'fee',
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
    /**
     * The ruleset version pinned at creation (the active one then), which every entry to
     * this contest is evaluated under; `null` only on a contest created before a ruleset
     * existed, which falls back to the active version at evaluation.
     */
    eligibilityRulesetVersion: text('eligibility_ruleset_version').references(() => rulesets.version),
    /**
     * The platform's take, in basis points of the escrowed pool, frozen at creation
     * (spec section 14.3). Held on the contest rather than read from the live ruleset at
     * settlement so the rake a contest was opened under cannot change underneath its
     * entrants. 0 is the default and every free-to-play contest keeps it, so the rake is
     * additive: a contest created before this column existed behaves exactly as it did.
     */
    rakeBps: integer('rake_bps').notNull().default(0),
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
    // A rake over half the pool is a configuration mistake, not a business model.
    check('contests_rake_bps_range', sql`${table.rakeBps} between 0 and 5000`),
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
 * row with a fresh escrow entry and the new request's `team_ref` and `seed`, the only
 * move on which those two may change (docs/decisions.md). `seed` feeds the
 * `higher_seed_wins` tie-break (lower is better).
 */
export const contestParticipants = pgTable(
  'contest_participants',
  {
    id: text('id').primaryKey(),
    contestId: text('contest_id')
      .notNull()
      .references(() => contests.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
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
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    score: numeric('score', { mode: 'number' }),
    attemptFinished: boolean('attempt_finished').notNull().default(false),
    /** Set by the service to `clock_timestamp()` after the contest lock is held, so per contest it follows submission order. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    /** The partner's reference for where this score came from (a match id, a consensus record). */
    sourceRef: text('source_ref'),
    supersededBy: text('superseded_by'),
    /**
     * Signed score attestation (spec section 12, item 1; `@purse/types` `attestation.ts`):
     * `none` when the batch carried no attestation for this score, `verified` when a device
     * registered to the attesting user signed exactly this content for this `source_ref`,
     * `unverified` when one was presented under a key Purse does not hold. Fixed at insert
     * like everything else on the row: a later revocation never rewrites history.
     */
    attestationState: text('attestation_state').$type<AttestationState>().notNull().default('none'),
    /** The attestation as presented, verbatim, plus the device it was checked against; null when the state is `none`. */
    attestation: jsonb('attestation').$type<ScoreAttestationResource>(),
  },
  (table) => [
    idCheck('contest_scores_id_prefix', table.id, 'sco'),
    idCheck('contest_scores_user_id_prefix', table.userId, 'usr'),
    foreignKey({ name: 'contest_scores_superseded_by_fk', columns: [table.supersededBy], foreignColumns: [table.id] }),
    check('contest_scores_not_self_superseded', sql`${table.supersededBy} is null or ${table.supersededBy} <> ${table.id}`),
    check('contest_scores_attestation_state', sql`${table.attestationState} in ('none', 'verified', 'unverified')`),
    check('contest_scores_attestation_pair', sql`(${table.attestationState} = 'none') = (${table.attestation} is null)`),
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
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
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
 * Two layers record a partner's key, distinguished by `scope`: the service layer inside
 * the operation's own transaction, and the HTTP layer once the response is known.
 */
export const idempotencyScope = pgEnum('idempotency_scope', ['service', 'http']);
export type IdempotencyScope = (typeof idempotencyScope.enumValues)[number];

/**
 * Spec 4.1 `idempotency_keys`, the record behind "every Purse mutation is idempotent"
 * (spec section 2, rule 4). One row per (tenant, scope, key):
 *
 * - `service` rows are written by `src/contests/idempotency.ts` inside the operation's
 *   transaction: the operation, a hash of the request, and a small JSON `result` of the
 *   ids the operation produced, from which a replay reloads and returns the original
 *   result. They commit with the effects they describe or not at all.
 * - `http` rows are written by the v1 idempotency middleware (`src/http/idempotency.ts`)
 *   once the response is known, after the request's effects have committed: `operation`
 *   is the endpoint (`POST /v1/contests/:id/entries`), `request_hash` covers the method,
 *   path and body, and `response_status` and `response_body` are what every replay of the
 *   key is answered with, unchanged. A different request under a used key is a conflict
 *   at whichever layer sees it first.
 *
 * Append-only for the runtime; rows are eligible for removal after the 30-day TTL
 * (spec 4.1) by `pnpm --filter @purse/api db:purge`, which runs as the owner.
 */
export const IDEMPOTENCY_TTL_DAYS = 30;

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scope: idempotencyScope('scope').notNull(),
    key: text('key').notNull(),
    /** The service operation (`contest.enter`) or, for an `http` row, the endpoint. */
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [table.tenantId, table.scope, table.key] }),
    check(
      'idempotency_keys_scope_shape',
      sql`(${table.scope} = 'service' and ${table.result} is not null and ${table.responseStatus} is null and ${table.responseBody} is null)
        or (${table.scope} = 'http' and ${table.result} is null and ${table.responseStatus} between 100 and 599 and ${table.responseBody} is not null)`,
    ),
    index('idempotency_keys_created_at_idx').on(table.createdAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;

/**
 * The claim the v1 middleware holds on an `http` key while its request is in flight: one
 * row per (tenant, key), written before the handler runs and re-claimed by a retry once
 * `expires_at` has passed, so a request that crashed between its effects and its stored
 * response does not hold the key forever. A live claim tells a concurrent replay to wait
 * for the stored row; a 5xx releases it by expiring it. Not history: the runtime updates
 * every column but the key, and the purge removes rows with the keys they guarded.
 */
export const idempotencyReservations = pgTable(
  'idempotency_reservations',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    /** The endpoint, for the conflict a different request under a live key reports. */
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: 'idempotency_reservations_pkey', columns: [table.tenantId, table.key] }),
    check('idempotency_reservations_window', sql`${table.expiresAt} >= ${table.reservedAt}`),
    index('idempotency_reservations_reserved_at_idx').on(table.reservedAt),
  ],
);

export type IdempotencyReservation = typeof idempotencyReservations.$inferSelect;

// ---- Identity (spec 4.1, decision D8) ------------------------------------------------

/**
 * Purse owns the wallet-bearing identity; the partner links its own account to it by
 * `external_id`, unique per tenant (decision D8). `phone_e164` and `date_of_birth` are the
 * demographics the eligibility engine and the identity provider need; nothing here is a
 * document. The runtime may update the three demographic fields (a partner upsert
 * corrects a name or a date of birth) and nothing else; a trigger holds the identity
 * fields immutable for every role.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The partner's opaque id for this user. */
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    phoneE164: text('phone_e164'),
    /** `YYYY-MM-DD`; a date, never an instant, so it does not shift with a timezone. */
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    ...timestamps,
  },
  (table) => [
    idCheck('users_id_prefix', table.id, 'usr'),
    unique('users_tenant_id_external_id_key').on(table.tenantId, table.externalId),
    check('users_external_id_not_blank', sql`length(trim(${table.externalId})) > 0 and length(${table.externalId}) <= 255`),
    check('users_display_name_length', sql`${table.displayName} is null or (length(trim(${table.displayName})) > 0 and length(${table.displayName}) <= 200)`),
    check('users_phone_e164_shape', sql`${table.phoneE164} is null or ${table.phoneE164} ~ '^\\+[1-9][0-9]{6,14}$'`),
    index('users_tenant_id_idx').on(table.tenantId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const verificationState = pgEnum('verification_state', ['unstarted', 'pending', 'verified', 'rejected']);
export type VerificationState = (typeof verificationState.enumValues)[number];

/**
 * Spec 4.1 `user_verification`: the KYC state machine, one row per user, created
 * `unstarted` with the user. `provider` names the seam that decided (`dev`, later
 * `persona`); `provider_ref` is that provider's opaque reference for the check and is held
 * to a short token shape by a CHECK, so a URL, a document, an image or a JSON blob cannot
 * be stored in it. There is no other free-form column: identity documents never enter this
 * database (spec 4.1, "No identity documents, ever"). The state graph is held by the
 * `user_verification_state_machine` trigger for every role and by
 * `src/users/verification.ts` for the runtime.
 */
export const userVerification = pgTable(
  'user_verification',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id),
    state: verificationState('state').notNull().default('unstarted'),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** After this instant a verified user must verify again before a verification-gated entry. */
    reverifyAfter: timestamp('reverify_after', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_verification_provider_shape', sql`${table.provider} is null or ${table.provider} ~ '^[a-z][a-z0-9_-]{0,63}$'`),
    check('user_verification_provider_ref_opaque', sql`${table.providerRef} is null or ${table.providerRef} ~ '^[A-Za-z0-9._:-]{1,128}$'`),
    check('user_verification_verified_at_iff_verified', sql`(${table.state} = 'verified') = (${table.verifiedAt} is not null)`),
    check('user_verification_reverify_needs_verified', sql`${table.reverifyAfter} is null or ${table.verifiedAt} is not null`),
    check('user_verification_provider_once_started', sql`(${table.state} = 'unstarted') = (${table.provider} is null)`),
  ],
);

export type UserVerification = typeof userVerification.$inferSelect;

export const restrictionKind = pgEnum('restriction_kind', ['self_exclusion', 'cool_off', 'platform_block', 'velocity_lock']);
export type RestrictionKind = (typeof restrictionKind.enumValues)[number];

/**
 * Spec 4.1 `user_restrictions`, honoured before every entry (spec 4.6). A restriction is in
 * force from `starts_at` until `ends_at` (or indefinitely) unless it has been lifted.
 * Lifting is the one runtime update, recorded once with who did it; a user never lifts
 * their own self-exclusion or cool-off (`src/users/restrictions.ts`), which is what makes
 * them "irreversible by the user for the duration".
 */
export const userRestrictions = pgTable(
  'user_restrictions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: restrictionKind('kind').notNull(),
    reason: text('reason'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** Actor reference: `user:<id>`, `operator:<ref>`, `system`. */
    createdBy: text('created_by').notNull(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: text('lifted_by'),
    ...timestamps,
  },
  (table) => [
    idCheck('user_restrictions_id_prefix', table.id, 'rst'),
    check('user_restrictions_ends_after_starts', sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`),
    check('user_restrictions_lifted_pair', sql`(${table.liftedAt} is null) = (${table.liftedBy} is null)`),
    check('user_restrictions_reason_length', sql`${table.reason} is null or length(${table.reason}) <= 500`),
    index('user_restrictions_user_id_kind_idx').on(table.userId, table.kind),
  ],
);

export type UserRestriction = typeof userRestrictions.$inferSelect;

/**
 * Signed score attestation (spec section 12, item 1): one registered device key of one
 * user. The partner registers the public half of a WebCrypto P-256 key pair the device
 * generated (the private half is non-extractable and never leaves the browser), and every
 * score submitted for that user (or a teammate, the partner says whose) may carry a
 * signature Purse checks against this row (`src/attestation/verify.ts`). `key_id` is the
 * JWK thumbprint, derived from the key and never chosen. A revocation is the one runtime
 * update and is never undone; a lost or replaced device is a new row under a new key,
 * and re-registering a revoked key is a new row too (the partial unique index admits one
 * live row per key per user).
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull().default('ES256'),
    publicKey: jsonb('public_key').$type<EcPublicJwk>().notNull(),
    /** The partner's label (a team, "this phone"); never anything that identifies a person. */
    label: text('label'),
    /** Actor reference of the registration: `key:<prefix>`, `operator:<ref>`. */
    createdBy: text('created_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokedReason: text('revoked_reason'),
    ...timestamps,
  },
  (table) => [
    idCheck('user_devices_id_prefix', table.id, 'udv'),
    idCheck('user_devices_user_id_prefix', table.userId, 'usr'),
    check('user_devices_key_id_shape', sql`${table.keyId} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('user_devices_algorithm', sql`${table.algorithm} in ('ES256')`),
    check('user_devices_label_length', sql`${table.label} is null or length(${table.label}) <= 120`),
    check('user_devices_revoked_pair', sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`),
    check('user_devices_revoked_reason_length', sql`${table.revokedReason} is null or length(${table.revokedReason}) <= 500`),
    uniqueIndex('user_devices_live_key').on(table.userId, table.keyId).where(sql`${table.revokedAt} is null`),
    index('user_devices_user_id_idx').on(table.userId),
  ],
);

export type UserDevice = typeof userDevices.$inferSelect;

export const locationSource = pgEnum('location_source', ['ip', 'declared', 'provider']);
export type LocationSource = (typeof locationSource.enumValues)[number];

/**
 * Spec 4.1 `user_locations`: the user's current resolved region, one row per user,
 * overwritten by each resolution (the `GeoProvider` seam). `region_code` is ISO 3166-1
 * alpha-2 with an optional 3166-2 subdivision (`US-TX`). `confidence` is 0 to 1 and is
 * not money. The region in force at each entry decision is copied onto the decision
 * record, so overwriting here loses no audit history.
 */
export const userLocations = pgTable(
  'user_locations',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id),
    regionCode: text('region_code').notNull(),
    source: locationSource('source').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_locations_region_code_shape', sql`${table.regionCode} ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'`),
    check('user_locations_confidence_range', sql`${table.confidence} >= 0 and ${table.confidence} <= 1`),
  ],
);

export type UserLocation = typeof userLocations.$inferSelect;

// ---- Eligibility (spec 4.5, decision D9) ---------------------------------------------

/**
 * Versioned rulesets. `body` is validated by `rulesetSchema` (`src/eligibility/ruleset.ts`)
 * before it is stored and again when it is loaded; it never changes once written (a trigger
 * holds that for every role). Exactly one version is active at a time, which the partial
 * unique index enforces. The version, not a surrogate id, is the key: it is what every
 * persisted decision and every contest names.
 */
export const rulesets = pgTable(
  'rulesets',
  {
    version: text('version').primaryKey(),
    body: jsonb('body').$type<Ruleset>().notNull(),
    active: boolean('active').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check('rulesets_version_shape', sql`${table.version} ~ '^[0-9]{4}\\.[0-9]{1,2}\\.[0-9]+$'`),
    uniqueIndex('rulesets_one_active_key')
      .on(table.active)
      .where(sql`${table.active}`),
  ],
);

export type RulesetRow = typeof rulesets.$inferSelect;

/**
 * One row per entry attempt (spec 4.5, decision D9): what the evaluator decided, under
 * which ruleset version, with the sealed reasons and required action, and `context`, the
 * evaluator's input as it stood (region, verification state, active restrictions, age,
 * balance, velocity) so an auditor can rerun the decision. Written whether or not the
 * entry went through: a refusal is recorded and the transaction that would have escrowed
 * the stake is not. Append-only.
 */
export const eligibilityDecisions = pgTable(
  'eligibility_decisions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    contestId: text('contest_id')
      .notNull()
      .references(() => contests.id),
    rulesetVersion: text('ruleset_version')
      .notNull()
      .references(() => rulesets.version),
    allowed: boolean('allowed').notNull(),
    reasons: text('reasons').array().$type<EligibilityReason[]>().notNull(),
    requiredAction: text('required_action').$type<RequiredAction>(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('eligibility_decisions_id_prefix', table.id, 'eld'),
    check('eligibility_decisions_reasons_iff_refused', sql`${table.allowed} = (cardinality(${table.reasons}) = 0)`),
    check('eligibility_decisions_action_needs_refusal', sql`${table.requiredAction} is null or not ${table.allowed}`),
    index('eligibility_decisions_user_id_created_at_idx').on(table.userId, table.createdAt),
    index('eligibility_decisions_contest_id_idx').on(table.contestId),
  ],
);

export type EligibilityDecisionRow = typeof eligibilityDecisions.$inferSelect;

// ---- Risk controls (spec 4.6) --------------------------------------------------------

/**
 * Duplicate-identity detection: SHA-256 of the normalised display name and the date of
 * birth, one row per user, recomputed when either changes. A collision with another user
 * of the same tenant is flagged into `operator_flags` for review, never acted on.
 */
export const identityFingerprints = pgTable(
  'identity_fingerprints',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fingerprint: text('fingerprint').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('identity_fingerprints_shape', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    index('identity_fingerprints_tenant_id_fingerprint_idx').on(table.tenantId, table.fingerprint),
  ],
);

export type IdentityFingerprint = typeof identityFingerprints.$inferSelect;

export const operatorFlagKind = pgEnum('operator_flag_kind', ['duplicate_identity', 'collusion_signal', 'risk_review']);
export type OperatorFlagKind = (typeof operatorFlagKind.enumValues)[number];

export const operatorFlagStatus = pgEnum('operator_flag_status', ['open', 'reviewed', 'dismissed']);
export type OperatorFlagStatus = (typeof operatorFlagStatus.enumValues)[number];

/**
 * What the risk controls surface for a human (spec 4.6: flag, do not auto-block). `subject`
 * is the user or, for a collusion signal, the pair; `dedupe_key` keeps one open flag per
 * finding. The operator console (phase 5) reads and resolves these; the runtime may only
 * change `status` and who reviewed it.
 */
export const operatorFlags = pgTable(
  'operator_flags',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: operatorFlagKind('kind').notNull(),
    subject: text('subject').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    status: operatorFlagStatus('status').notNull().default('open'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    ...timestamps,
  },
  (table) => [
    idCheck('operator_flags_id_prefix', table.id, 'flg'),
    unique('operator_flags_tenant_id_kind_dedupe_key_key').on(table.tenantId, table.kind, table.dedupeKey),
    check('operator_flags_reviewed_pair', sql`(${table.status} = 'open') = (${table.reviewedAt} is null) and (${table.reviewedAt} is null) = (${table.reviewedBy} is null)`),
    index('operator_flags_tenant_id_status_idx').on(table.tenantId, table.status),
  ],
);

export type OperatorFlag = typeof operatorFlags.$inferSelect;

// ---- API keys and embed tokens (spec 4.1, 4.8) ---------------------------------------

export const apiKeyKind = pgEnum('api_key_kind', ['secret', 'publishable']);
export type ApiKeyKind = (typeof apiKeyKind.enumValues)[number];

export const apiKeyEnvironment = pgEnum('api_key_environment', ['sandbox', 'live']);
export type ApiKeyEnvironment = (typeof apiKeyEnvironment.enumValues)[number];

/** The one scope a secret key may carry: operator-only routes (credits, operator close). See docs/decisions.md. */
export const API_KEY_SCOPES = ['operator'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Spec 4.1 `api_keys`. Only the argon2id hash of a key is stored; the plaintext is shown
 * once, at creation. `key_prefix` is the visible head of the key (`sk_sandbox_Ab12Cd34`),
 * enough to find the candidate row and to name the key in a console, never enough to use
 * it. `scopes` is the operator flag on a secret key (decision recorded in
 * docs/decisions.md); a publishable key has none. The runtime updates `last_used_at` (at
 * most once a minute) and `revoked_at` (once) and nothing else.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: apiKeyKind('kind').notNull(),
    environment: apiKeyEnvironment('environment').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().$type<ApiKeyScope[]>().notNull().default(sql`'{}'::text[]`),
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    idCheck('api_keys_id_prefix', table.id, 'key'),
    check('api_keys_key_hash_argon2id', sql`${table.keyHash} like '$argon2id$%'`),
    check(
      'api_keys_key_prefix_shape',
      sql`${table.keyPrefix} ~ '^(sk|pk)_(sandbox|live)_[A-Za-z0-9]{8}$'
        and ${table.keyPrefix} like (case ${table.kind} when 'secret' then 'sk_' else 'pk_' end) || ${table.environment}::text || '_%'`,
    ),
    check('api_keys_scopes_known', sql`${table.scopes} <@ '{operator}'::text[] and (${table.kind} = 'secret' or cardinality(${table.scopes}) = 0)`),
    check('api_keys_label_length', sql`${table.label} is null or length(${table.label}) <= 100`),
    index('api_keys_key_prefix_idx').on(table.keyPrefix),
    index('api_keys_tenant_id_idx').on(table.tenantId),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;

export const embedFlow = pgEnum('embed_flow', ['identity', 'wallet', 'entry', 'rewards']);
export type EmbedFlowValue = (typeof embedFlow.enumValues)[number];

/**
 * Spec 4.8 rule 5: an embed token is single-use, scoped to one user and one flow, and
 * expires in five minutes. Only its SHA-256 is stored (the token is 256 bits of randomness,
 * so a plain digest is the right hash); consuming it is one `UPDATE ... WHERE consumed_at
 * IS NULL`, which is what makes "single use" hold under concurrency. Phase 4's iframe
 * bootstrap is the consumer.
 */
export const embedTokens = pgTable(
  'embed_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    flow: embedFlow('flow').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('embed_tokens_id_prefix', table.id, 'emb'),
    uniqueIndex('embed_tokens_token_hash_key').on(table.tokenHash),
    check('embed_tokens_token_hash_shape', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('embed_tokens_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    index('embed_tokens_user_id_idx').on(table.userId),
  ],
);

export type EmbedToken = typeof embedTokens.$inferSelect;

// ---- Embed origins and sign-in (spec 4.8) --------------------------------------------

/**
 * The origins a tenant's pages may embed Purse flows from (spec 4.8 rule 3): the
 * receiver in the embed app validates `event.origin` and the `parent` it was opened with
 * against this list, the API's CORS answers name only these, and the embed page's
 * `frame-ancestors` is their union. An origin is a scheme, host and optional port and
 * nothing else. Revoking keeps the row with `revoked_at` set; re-adding clears it.
 */
export const tenantOrigins = pgTable(
  'tenant_origins',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    origin: text('origin').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'tenant_origins_pkey', columns: [table.tenantId, table.origin] }),
    check('tenant_origins_origin_shape', sql`${table.origin} ~ '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'`),
  ],
);

export type TenantOrigin = typeof tenantOrigins.$inferSelect;

/**
 * One-time sign-in codes for the embed's `signin` flow: six digits, ten minutes, five
 * guesses, stored only as an HMAC keyed by the process secret and bound to the phone they
 * were sent to. A code is consumed once; the runtime updates the guess count and the
 * consumption and nothing else. Rows are purged with the other short-lived plumbing.
 */
export const embedSigninCodes = pgTable(
  'embed_signin_codes',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    phoneE164: text('phone_e164').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('embed_signin_codes_id_prefix', table.id, 'sic'),
    check('embed_signin_codes_phone_shape', sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('embed_signin_codes_hash_shape', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('embed_signin_codes_attempts_range', sql`${table.attempts} >= 0 and ${table.attempts} <= 100`),
    check('embed_signin_codes_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    index('embed_signin_codes_tenant_phone_created_idx').on(table.tenantId, table.phoneE164, table.createdAt),
  ],
);

export type EmbedSigninCode = typeof embedSigninCodes.$inferSelect;

// ---- Webhooks (spec 4.1, 4.9) --------------------------------------------------------

export const webhookEndpointStatus = pgEnum('webhook_endpoint_status', ['enabled', 'disabled']);
export type WebhookEndpointStatusValue = (typeof webhookEndpointStatus.enumValues)[number];

/** The spec 4.9 list, held by a CHECK on both webhook tables so a typo cannot be subscribed to or delivered. */
export const WEBHOOK_EVENT_TYPE_LITERAL = `'{user.verification.updated,contest.opened,contest.locked,contest.settled,contest.voided,contest.entry.created,contest.entry.withdrawn,wallet.balance.changed}'::text[]`;

/**
 * Spec 4.1 `webhook_endpoints`. `signing_secret` holds the AES-256-GCM envelope of the
 * secret (`src/webhooks/secrets.ts`, keyed from `PURSE_SECRET_KEY`), never the secret
 * itself: the dispatcher needs it back to sign, so it cannot be a one-way hash like an
 * API key's, and a database dump alone must not reveal it (docs/decisions.md). The
 * plaintext is returned once, on creation and on rotation. The runtime may change the
 * URL, the subscriptions, the status, the description and the secret (a rotation).
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    url: text('url').notNull(),
    signingSecret: text('signing_secret').notNull(),
    subscribedEvents: text('subscribed_events').array().$type<WebhookEventType[]>().notNull(),
    status: webhookEndpointStatus('status').notNull().default('enabled'),
    description: text('description'),
    ...timestamps,
  },
  (table) => [
    idCheck('webhook_endpoints_id_prefix', table.id, 'whe'),
    check('webhook_endpoints_url_shape', sql`${table.url} ~ '^https?://[^[:space:]]+$' and length(${table.url}) <= 2000`),
    check('webhook_endpoints_secret_envelope', sql`${table.signingSecret} like 'enc:v1:%'`),
    check('webhook_endpoints_events_known', sql`${table.subscribedEvents} <@ ${sql.raw(WEBHOOK_EVENT_TYPE_LITERAL)} and cardinality(${table.subscribedEvents}) >= 1`),
    check('webhook_endpoints_description_length', sql`${table.description} is null or length(${table.description}) <= 200`),
    index('webhook_endpoints_tenant_id_idx').on(table.tenantId),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'dead']);
export type WebhookDeliveryStatusValue = (typeof webhookDeliveryStatus.enumValues)[number];

/** Spec 4.9: eight attempts over roughly a day, then `dead`. The schedule itself is `src/webhooks/schedule.ts`. */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/**
 * Spec 4.1 `webhook_deliveries`: one row per event per subscribed endpoint, written in the
 * transaction that produced the event (the outbox), so a delivery exists if and only if
 * the change it reports committed. `payload` is the signed body as sent, event `id`
 * included, identical on every attempt. `pending` awaits the first attempt, `failed`
 * awaits a retry at `next_attempt_at`, `delivered` got a 2xx, `dead` exhausted the
 * schedule. A replay is a new row for the same event naming the one it repeats. The
 * dispatcher leases a row (`locked_until`, `locked_by`) so one process attempts it at a
 * time and a crashed process's lease expires.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').$type<WebhookEventType>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(WEBHOOK_MAX_ATTEMPTS),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockedBy: text('locked_by'),
    replayOf: text('replay_of'),
    ...timestamps,
  },
  (table) => [
    idCheck('webhook_deliveries_id_prefix', table.id, 'whd'),
    idCheck('webhook_deliveries_event_id_prefix', table.eventId, 'evt'),
    nullableIdCheck('webhook_deliveries_replay_of_prefix', table.replayOf, 'whd'),
    foreignKey({ name: 'webhook_deliveries_replay_of_fk', columns: [table.replayOf], foreignColumns: [table.id] }),
    check('webhook_deliveries_event_type_known', sql`${table.eventType} = any(${sql.raw(WEBHOOK_EVENT_TYPE_LITERAL)})`),
    check('webhook_deliveries_attempt_range', sql`${table.attempt} >= 0 and ${table.attempt} <= ${table.maxAttempts} and ${table.maxAttempts} >= 1`),
    check('webhook_deliveries_delivered_at_iff_delivered', sql`(${table.status} = 'delivered') = (${table.deliveredAt} is not null)`),
    check('webhook_deliveries_response_status_range', sql`${table.responseStatus} is null or (${table.responseStatus} between 100 and 599)`),
    check('webhook_deliveries_lock_pair', sql`(${table.lockedUntil} is null) = (${table.lockedBy} is null)`),
    // One delivery per event per endpoint; a replay is a further row naming the first.
    uniqueIndex('webhook_deliveries_endpoint_event_key')
      .on(table.endpointId, table.eventId)
      .where(sql`${table.replayOf} is null`),
    index('webhook_deliveries_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'failed')`),
    index('webhook_deliveries_event_id_idx').on(table.eventId),
    index('webhook_deliveries_tenant_id_created_at_idx').on(table.tenantId, table.createdAt),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/**
 * Spec 4.9 "persist every attempt": one append-only row per HTTP attempt, with the
 * response status or the reason none arrived (a timeout, a refused connection), never a
 * response body. `attempt` numbers from 1 within the delivery.
 */
export const webhookDeliveryAttempts = pgTable(
  'webhook_delivery_attempts',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => webhookDeliveries.id),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    responseStatus: integer('response_status'),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('webhook_delivery_attempts_id_prefix', table.id, 'wha'),
    unique('webhook_delivery_attempts_delivery_id_attempt_key').on(table.deliveryId, table.attempt),
    check('webhook_delivery_attempts_attempt_positive', sql`${table.attempt} >= 1`),
    check('webhook_delivery_attempts_response_status_range', sql`${table.responseStatus} is null or (${table.responseStatus} between 100 and 599)`),
    check('webhook_delivery_attempts_error_length', sql`${table.error} is null or length(${table.error}) <= 500`),
    check('webhook_delivery_attempts_duration_range', sql`${table.durationMs} >= 0`),
    check('webhook_delivery_attempts_finished_after_started', sql`${table.finishedAt} >= ${table.startedAt}`),
  ],
);

export type WebhookDeliveryAttempt = typeof webhookDeliveryAttempts.$inferSelect;

// ---- Operator console (spec 4.10) ----------------------------------------------------

export const operatorRole = pgEnum('operator_role', ['admin', 'operator']);
export type OperatorRole = (typeof operatorRole.enumValues)[number];

/**
 * The console's own accounts (spec 4.10: "behind its own auth"). Nothing here is a
 * partner or a user: an operator is a member of the platform's staff, signs in with an
 * email and a password (argon2id, the same parameters as API keys; a CHECK refuses anything
 * but a hash), and acts as the `operator` audit actor with the operator id as its ref.
 * `admin` may also do the platform-shaping things (tenant status, API keys, rulesets;
 * docs/decisions.md, phase 5). The runtime may change the password hash and nothing else;
 * creating and disabling operators is the seed's and the owner's, for now.
 */
export const operators = pgTable(
  'operators',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: operatorRole('role').notNull().default('operator'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    idCheck('operators_id_prefix', table.id, 'opr'),
    uniqueIndex('operators_email_key').on(table.email),
    check('operators_email_shape', sql`${table.email} = lower(${table.email}) and ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$' and length(${table.email}) <= 254`),
    check('operators_password_hash_argon2id', sql`${table.passwordHash} like '$argon2id$%'`),
  ],
);

export type Operator = typeof operators.$inferSelect;

/**
 * Console sessions: one row per sign-in, storing only the SHA-256 of a 256-bit random
 * token (the console's cookie carries the token; the API sees it as a bearer). A session
 * ends at `expires_at` or when it is revoked (sign-out), and a revoked session never comes
 * back; `last_seen_at` is written at most once a minute. Stateful, unlike the embed's
 * signed cookie, so an operator's sessions can be revoked at once. Expired and revoked
 * rows are removed by `pnpm --filter @purse/api db:purge`.
 */
export const operatorSessions = pgTable(
  'operator_sessions',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id')
      .notNull()
      .references(() => operators.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('operator_sessions_id_prefix', table.id, 'ops'),
    uniqueIndex('operator_sessions_token_hash_key').on(table.tokenHash),
    check('operator_sessions_token_hash_shape', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('operator_sessions_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    index('operator_sessions_operator_id_idx').on(table.operatorId),
    index('operator_sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export type OperatorSession = typeof operatorSessions.$inferSelect;

// ---- Operations (phase 9) ------------------------------------------------------------

/** Who ran the invariants: the scheduled job, the internal route, the console's panel, the CLI, or a test. */
export const reconcileRunSource = pgEnum('reconcile_run_source', ['schedule', 'internal', 'console', 'cli', 'test']);
export type ReconcileRunSource = (typeof reconcileRunSource.enumValues)[number];

/**
 * One row per `reconcile()` run (spec section 10: "`GET /health` returns ... last reconcile
 * result"). Written by whoever ran the invariants, read by `/health`, which reports the
 * newest row rather than re-running the checks on every probe. Append-only: a run is a
 * fact about the ledger at a moment, and a failed one stays on the record (the runtime
 * gets `SELECT, INSERT` only, `drizzle/0016_reconcile_run_grants.sql`). `failed` is the
 * list of failed invariant ids so an uptime check can name them without opening `report`.
 */
export const reconcileRuns = pgTable(
  'reconcile_runs',
  {
    id: text('id').primaryKey(),
    ok: boolean('ok').notNull(),
    source: reconcileRunSource('source').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    failed: jsonb('failed').$type<string[]>().notNull(),
    report: jsonb('report').$type<ReconcileReport>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('reconcile_runs_id_prefix', table.id, 'rcr'),
    check('reconcile_runs_duration_non_negative', sql`${table.durationMs} >= 0`),
    check('reconcile_runs_failed_matches_ok', sql`(${table.ok} and jsonb_array_length(${table.failed}) = 0) or (not ${table.ok} and jsonb_array_length(${table.failed}) > 0)`),
    index('reconcile_runs_ran_at_idx').on(table.ranAt),
  ],
);

export type ReconcileRun = typeof reconcileRuns.$inferSelect;

// ---- Treasury (spec section 14) ------------------------------------------------------

/**
 * The fiat rail, and the one place in this repository where real currency is named.
 *
 * Decision D3 and spec 4.2.6 are unchanged and still enforced: there is no account of
 * asset `USD` in Purse, the asset enum cannot express one, and
 * `test/ledger/usd.test.ts` still proves it. That is deliberate rather than a gap, and it
 * is the same split a merchant of record actually runs: custodied dollars sit at a payment
 * service provider and a bank, while the double-entry journal tracks each user's *claim*
 * on them in a closed-loop asset. `CREDIT` is that claim, one minor unit to one US cent,
 * so a wallet holding 2,500 CREDIT is a claim on $25.00 held in custody.
 *
 * A payment is therefore the money leg **outside** the journal: it records what the rail
 * did in USD cents. Its in-ledger effect is a single balanced entry in `CREDIT`
 * (`deposit`: debit `external_settlement`, credit the wallet; `withdrawal`: the mirror),
 * linked by `journal_entry_id`. Invariant I8 holds the two sides to each other, so the
 * custody position implied by the rail and the position implied by the ledger can never
 * quietly diverge.
 */

/** Which way money moves across the rail, from the user's point of view. */
export const paymentDirection = pgEnum('payment_direction', ['deposit', 'withdrawal']);
export type PaymentDirection = (typeof paymentDirection.enumValues)[number];

/**
 * The payment state machine (spec 14.2). Deposits and withdrawals share one enum because
 * they share one table and one audit trail; which states are reachable depends on the
 * direction, and `paymentsDirectionStates` below is the database's own statement of that.
 *
 * Deposit:    `requires_action` -> `authorized` -> `captured` -> `settled`
 * Withdrawal: `requested` -> `in_review` -> `approved` -> `paid`
 * Either may end `failed`, `cancelled` or (a deposit) `refunded`; a withdrawal the bank
 * sends back ends `returned`.
 */
export const paymentState = pgEnum('payment_state', [
  'requires_action',
  'authorized',
  'captured',
  'settled',
  'requested',
  'in_review',
  'approved',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'returned',
]);
export type PaymentState = (typeof paymentState.enumValues)[number];

/** The states a payment can hold with no further movement expected. */
export const TERMINAL_PAYMENT_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'settled',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'returned',
]);

/** The state at which a deposit's funds are credited to the wallet, and a withdrawal's are debited. */
export const FUNDING_STATE: Readonly<Record<PaymentDirection, PaymentState>> = {
  deposit: 'captured',
  withdrawal: 'approved',
};

/**
 * Instrument families the rail accepts. `mastercard` is present and permanently
 * unsupported rather than absent: the partner this was modelled on does not accept it, and
 * a brand that is merely missing from an enum produces a confusing `invalid_request`
 * instead of an honest, testable `instrument_not_supported`. `UNSUPPORTED_BRANDS` is the
 * rule, and the database enforces it on the row.
 */
export const paymentMethodBrand = pgEnum('payment_method_brand', [
  'visa',
  'mastercard',
  'amex',
  'discover',
  'bank_account',
  'apple_pay',
  'paypal',
]);
export type PaymentMethodBrand = (typeof paymentMethodBrand.enumValues)[number];

/** Brands the rail declines to store, with the reason an API caller is given. */
export const UNSUPPORTED_BRANDS: Readonly<Partial<Record<PaymentMethodBrand, string>>> = {
  mastercard: 'the acquirer does not support Mastercard for this merchant category',
  paypal: 'PayPal is not enabled for this merchant yet',
};

export const paymentMethodStatus = pgEnum('payment_method_status', ['active', 'expired', 'removed']);
export type PaymentMethodStatus = (typeof paymentMethodStatus.enumValues)[number];

/**
 * A stored instrument. Purse holds what a receipt needs and nothing that could move money
 * on its own: a brand, the last four digits, an expiry month and year, and the provider's
 * opaque token. There is no column a PAN, a CVV, an IBAN or an account number could be
 * written to, and a CHECK holds `last4` to exactly four digits and `provider_ref` to a
 * token shape, so the schema itself is the statement that this database is out of PCI
 * scope.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    brand: paymentMethodBrand('brand').notNull(),
    last4: text('last4').notNull(),
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    /** The provider's token for the instrument. Opaque, short, and never a card number. */
    providerRef: text('provider_ref').notNull(),
    provider: text('provider').notNull(),
    status: paymentMethodStatus('status').notNull().default('active'),
    /** At most one active instrument per user is the default for a new payment. */
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    idCheck('payment_methods_id_prefix', table.id, 'pmt'),
    check('payment_methods_last4_shape', sql`${table.last4} ~ '^[0-9]{4}$'`),
    check('payment_methods_provider_ref_shape', sql`${table.providerRef} ~ '^[A-Za-z0-9_-]{6,64}$'`),
    // A brand the rail does not support can never be stored, whatever the service does.
    check('payment_methods_brand_supported', sql`${table.brand} not in ('mastercard', 'paypal')`),
    check(
      'payment_methods_expiry_together',
      sql`(${table.expMonth} is null) = (${table.expYear} is null) and (${table.expMonth} is null or (${table.expMonth} between 1 and 12 and ${table.expYear} between 2000 and 2100))`,
    ),
    // A card must carry an expiry; a bank account or a wallet must not.
    check(
      'payment_methods_expiry_by_brand',
      sql`case when ${table.brand} in ('visa', 'mastercard', 'amex', 'discover') then ${table.expMonth} is not null else true end`,
    ),
    unique('payment_methods_tenant_provider_ref_key').on(table.tenantId, table.providerRef),
    // One default per user, enforced by the database rather than by the service.
    uniqueIndex('payment_methods_one_default_per_user')
      .on(table.userId)
      .where(sql`${table.isDefault} and ${table.status} = 'active'`),
    index('payment_methods_user_id_idx').on(table.userId),
  ],
);

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type NewPaymentMethod = typeof paymentMethods.$inferInsert;

/**
 * One movement across the fiat rail.
 *
 * `amount_usd_cents` is what the user moves; `fee_usd_cents` is what the rail charges for
 * moving it, and is the platform's cost rather than its revenue (the rake is a journal
 * entry, not a payment). A deposit credits the wallet with `amount_usd_cents` of `CREDIT`
 * and never the amount less the fee: the processing cost is borne by the platform, which
 * is both what the partner this models does and the only version that keeps I8 a clean
 * one-to-one.
 *
 * `journal_entry_id` is the in-ledger leg, set exactly when the payment reaches its
 * funding state (`captured` for a deposit, `approved` for a withdrawal) and never unset;
 * `payments_journal_entry_iff_funded` is the database holding that rule. A payment that
 * fails before funding never had a ledger effect and has nothing to reverse.
 */
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    direction: paymentDirection('direction').notNull(),
    state: paymentState('state').notNull(),
    /** US cents. Strictly positive; the direction carries the sign. */
    amountUsdCents: bigint('amount_usd_cents', { mode: 'bigint' }).notNull(),
    /** What the rail charged the platform to move it, in US cents. Never taken from the user. */
    feeUsdCents: bigint('fee_usd_cents', { mode: 'bigint' }).notNull().default(sql`0`),
    /** The closed-loop asset the wallet leg is denominated in. `CREDIT`, one unit to one cent. */
    asset: asset('asset').notNull(),
    paymentMethodId: text('payment_method_id').references(() => paymentMethods.id),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref'),
    /** The in-ledger leg. Present exactly when the payment has funded. */
    journalEntryId: text('journal_entry_id').references(() => journalEntries.id),
    /** The risk seam's verdict on this movement, recorded whether or not it held it up. */
    riskDecision: text('risk_decision'),
    /** Why a payment ended where it did, for the receipt and the operator queue. */
    failureCode: text('failure_code'),
    statementDescriptor: text('statement_descriptor').notNull(),
    fundedAt: timestamp('funded_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    idCheck('payments_id_prefix', table.id, 'pay'),
    nullableIdCheck('payments_journal_entry_id_prefix', table.journalEntryId, 'je'),
    check('payments_amount_positive', sql`${table.amountUsdCents} > 0`),
    check('payments_fee_non_negative', sql`${table.feeUsdCents} >= 0`),
    // The wallet leg of a payment is always the cent-denominated closed-loop asset.
    check('payments_asset_is_credit', sql`${table.asset} = 'CREDIT'`),
    // Each direction may only hold the states its own machine defines.
    check(
      'payments_direction_states',
      sql`case ${table.direction}
        when 'deposit' then ${table.state} in ('requires_action', 'authorized', 'captured', 'settled', 'failed', 'cancelled', 'refunded')
        when 'withdrawal' then ${table.state} in ('requested', 'in_review', 'approved', 'paid', 'failed', 'cancelled', 'returned')
      end`,
    ),
    // A funded payment has its ledger leg, and an unfunded one has none. This is the rule
    // I8 depends on, so it is the database's to keep rather than the service's.
    check(
      'payments_journal_entry_iff_funded',
      sql`(${table.fundedAt} is not null) = (${table.journalEntryId} is not null)
        and (${table.fundedAt} is not null) = (case ${table.direction}
          when 'deposit' then ${table.state} in ('captured', 'settled', 'refunded')
          when 'withdrawal' then ${table.state} in ('approved', 'paid', 'returned')
        end)`,
    ),
    check('payments_completed_iff_terminal', sql`(${table.completedAt} is not null) = (${table.state} in ('settled', 'paid', 'failed', 'cancelled', 'refunded', 'returned'))`),
    check('payments_failure_code_shape', sql`${table.failureCode} is null or ${table.failureCode} ~ '^[a-z][a-z0-9_]{2,48}$'`),
    check('payments_statement_descriptor_shape', sql`length(${table.statementDescriptor}) between 5 and 22`),
    unique('payments_journal_entry_id_key').on(table.journalEntryId),
    unique('payments_tenant_provider_ref_key').on(table.tenantId, table.providerRef),
    index('payments_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('payments_user_id_idx').on(table.userId),
    index('payments_state_idx').on(table.state),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

/**
 * Every step a payment took, append-only (the runtime holds `SELECT, INSERT` on this table
 * and nothing else). This is what makes a single dollar narratable end to end: the row
 * order is the story, `from_state` is null only for the row that created the payment, and
 * nothing in it can be rewritten after the fact.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: text('id').primaryKey(),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id),
    fromState: paymentState('from_state'),
    toState: paymentState('to_state').notNull(),
    /** Who moved it: `provider`, `operator:<id>`, `system`, or the partner's key. */
    actor: text('actor').notNull(),
    detail: jsonb('detail').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    idCheck('payment_events_id_prefix', table.id, 'pev'),
    check('payment_events_moves', sql`${table.fromState} is null or ${table.fromState} <> ${table.toState}`),
    index('payment_events_payment_id_idx').on(table.paymentId, table.occurredAt),
  ],
);

export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
