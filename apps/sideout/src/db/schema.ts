/**
 * Sideout schema, system spec section 5.1: only what Purse does not own. Phase 6 ships
 * the domain: local accounts and their Purse link (decision D8), charities, sponsors,
 * donations, tournaments, teams, pools, matches, sets and the audit log. Phase 7 adds the
 * consensus tables (`score_submissions`, `match_consensus`, spec 5.2), the Purse link and
 * entry records (`users.purse_user_id`, `purse_entries`) and the two Purse audits
 * (`purse_calls`, every request and response; `purse_webhook_events`, every event received).
 *
 * Conventions (shared with Purse through `@repo/db`):
 * - Ids are typed-prefix UUID v7 strings checked at the database; every prefix is
 *   registered in `@repo/ids`, nowhere else.
 * - Timestamps are `timestamptz`.
 * - Enumerations are Postgres enums, not free text, so the database rejects a typo. The
 *   `*_VALUES` arrays exported next to each enum are what Zod schemas validate against.
 * - Money that appears here is real currency (charitable donations via Stripe), stored as
 *   `bigint` cents with an explicit `currency` on the `donations` row, and it never crosses
 *   into Purse (spec 4.2.6, decision D3). Contest value never appears in this database as
 *   a figure of its own: no column holds a `POINTS` or `CREDIT` amount. What Purse said is
 *   kept verbatim as an audit (`purse_calls.response_body`, a tournament's frozen close
 *   preview), never summed, moved or displayed as money Sideout holds.
 * - Purse objects are referenced by opaque `purse_*` id columns, never by foreign key, and
 *   the public API projection (`server/public-shape.ts`) omits every one of them.
 * - Row-count rules the database cannot express as a CHECK (a team is exactly two members,
 *   a pool is a partition of the field) live in `domain/` and are enforced by the services
 *   inside the transaction that writes the rows.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idCheck, timestamps } from '@repo/db';

import type { EcPublicJwk } from '@purse/types';

import type { StoredAttestation } from '../domain/attestation';
import type { DrawConfig } from '../domain/draw-config';
import type { FrozenClosePreview } from '../domain/close-preview';
import type { SetDifference, SubmittedSet } from '../domain/consensus';

const tz = (name: string) => timestamp(name, { withTimezone: true });
/** Real-currency minor units. Read into JavaScript as `bigint`, never `number`. */
const cents = (name: string) => bigint(name, { mode: 'bigint' });

/** E.164: a leading `+`, a non-zero country digit, then 6 to 14 more digits. */
export const PHONE_E164_PATTERN = '^\\+[1-9][0-9]{6,14}$';
/** Lowercase words joined by single hyphens, e.g. `sandbar-classic-2026`. */
export const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';

// ---- Enumerations ----------------------------------------------------------------------

export const userRole = pgEnum('user_role', ['player', 'organizer']);
export const USER_ROLES = userRole.enumValues;
export type UserRole = (typeof USER_ROLES)[number];

export const charityStatus = pgEnum('charity_status', ['active', 'inactive']);

export const sponsorTier = pgEnum('sponsor_tier', ['presenting', 'court', 'prize']);
export const SPONSOR_TIERS = sponsorTier.enumValues;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export const donationProvider = pgEnum('donation_provider', ['dev', 'stripe']);
export const DONATION_PROVIDERS = donationProvider.enumValues;
export type DonationProviderName = (typeof DONATION_PROVIDERS)[number];

export const donationStatus = pgEnum('donation_status', ['pending', 'succeeded', 'refunded', 'failed']);
export const DONATION_STATUSES = donationStatus.enumValues;
export type DonationStatus = (typeof DONATION_STATUSES)[number];

export const tournamentFormat = pgEnum('tournament_format', ['pool_to_bracket', 'single_elim', 'double_elim', 'round_robin']);
export const TOURNAMENT_FORMATS = tournamentFormat.enumValues;
export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];

export const division = pgEnum('division', ['open', 'womens', 'mens', 'coed', 'rec']);
export const DIVISIONS = division.enumValues;
export type Division = (typeof DIVISIONS)[number];

export const tournamentStatus = pgEnum('tournament_status', [
  'draft',
  'registration_open',
  'registration_closed',
  'live',
  'awaiting_settlement',
  'settled',
  'cancelled',
]);
export const TOURNAMENT_STATUSES = tournamentStatus.enumValues;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

/**
 * `forming` is the state between "the captain created the team" and "the entry donation
 * was made": the partner may still be joining. Only `registered` and `checked_in` teams
 * count toward capacity, appear publicly, or enter a draw (see docs/decisions.md).
 */
export const teamStatus = pgEnum('team_status', ['forming', 'registered', 'checked_in', 'withdrawn']);
export const TEAM_STATUSES = teamStatus.enumValues;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

export const teamRole = pgEnum('team_role', ['captain', 'player']);
export const TEAM_ROLES = teamRole.enumValues;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const matchStatus = pgEnum('match_status', [
  'scheduled',
  'in_progress',
  'awaiting_scores',
  'disputed',
  'final',
  'forfeited',
  'bye',
]);
export const MATCH_STATUSES = matchStatus.enumValues;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const matchSlot = pgEnum('match_slot', ['a', 'b']);
export const MATCH_SLOTS = matchSlot.enumValues;
export type MatchSlot = (typeof MATCH_SLOTS)[number];

export const actorKind = pgEnum('actor_kind', ['player', 'organizer', 'system']);
export const ACTOR_KINDS = actorKind.enumValues;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * The score consensus machine (spec 5.2): `awaiting_first` until a team submits,
 * `awaiting_second` until the other team does, then `agreed` (hashes equal) or `disputed`
 * (they differ; the organizer resolves it back to `agreed`). `pushed_to_purse` once Purse
 * accepted the agreed scores under the key minted at `agreed`, `confirmed` once Purse's
 * idempotent replay of that key proved it holds them (docs/decisions.md, phase 7).
 */
export const consensusState = pgEnum('consensus_state', ['awaiting_first', 'awaiting_second', 'agreed', 'disputed', 'pushed_to_purse', 'confirmed']);
export const CONSENSUS_STATES = consensusState.enumValues;
export type ConsensusState = (typeof CONSENSUS_STATES)[number];

/** Which side of the net the submitter typed from: `a` means "us" is team A. */
export const submissionPerspective = pgEnum('submission_perspective', ['a', 'b']);

/** `in_flight` until Purse answers; `succeeded` (2xx), `refused` (an error envelope) or `failed` (no answer at all). */
export const purseCallStatus = pgEnum('purse_call_status', ['in_flight', 'succeeded', 'refused', 'failed']);
export const PURSE_CALL_STATUSES = purseCallStatus.enumValues;
export type PurseCallStatus = (typeof PURSE_CALL_STATUSES)[number];

export const purseEntryState = pgEnum('purse_entry_state', ['entered', 'withdrawn']);
export const PURSE_ENTRY_STATES = purseEntryState.enumValues;
export type PurseEntryState = (typeof PURSE_ENTRY_STATES)[number];

/** Sets to 21 (deciding set to 15), best of one or three. Stored as a checked integer. */
export const BEST_OF_VALUES = [1, 3] as const;
export type BestOf = (typeof BEST_OF_VALUES)[number];

// ---- Identity ---------------------------------------------------------------------------

/**
 * A local account (decision D8, "B for the app session"). `purse_external_id` is the
 * opaque id Sideout mints and hands to Purse when it creates the wallet-bearing user in
 * phase 7; it is never the phone number or anything else a person could be identified by.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    purseExternalId: text('purse_external_id').notNull(),
    displayName: text('display_name').notNull(),
    phoneE164: text('phone_e164'),
    avatarUrl: text('avatar_url'),
    role: userRole('role').notNull().default('player'),
    /** The Purse user (`usr_`) created for `purse_external_id` by `POST /api/me/purse/link`; null until linked. */
    purseUserId: text('purse_user_id'),
    purseLinkedAt: tz('purse_linked_at'),
    /** Purse's verification state as last read back or announced by `user.verification.updated`. The wallet is never stored: the profile reads it live. */
    purseVerificationState: text('purse_verification_state'),
    ...timestamps,
  },
  (table) => [
    idCheck('users_id_prefix', table.id, 'sou'),
    uniqueIndex('users_purse_external_id_key').on(table.purseExternalId),
    uniqueIndex('users_purse_user_id_key').on(table.purseUserId),
    uniqueIndex('users_phone_e164_key').on(table.phoneE164),
    check('users_phone_e164_shape', sql`${table.phoneE164} IS NULL OR ${table.phoneE164} ~ ${sql.raw(`'${PHONE_E164_PATTERN}'`)}`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * One-time sign-in codes. Only the HMAC of the code is stored (`server/auth/codes.ts`);
 * a row is consumed on success and abandoned when it expires.
 */
export const authCodes = pgTable(
  'auth_codes',
  {
    id: text('id').primaryKey(),
    phoneE164: text('phone_e164').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: tz('expires_at').notNull(),
    consumedAt: tz('consumed_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('auth_codes_id_prefix', table.id, 'otp'),
    index('auth_codes_phone_created_idx').on(table.phoneE164, table.createdAt),
  ],
);

export type AuthCode = typeof authCodes.$inferSelect;

// ---- Charities and sponsors -------------------------------------------------------------

/** A beneficiary a tournament raises for. */
export const charities = pgTable(
  'charities',
  {
    id: text('id').primaryKey(),
    /** URL handle, e.g. `surfrider`. Lowercase letters, digits and hyphens. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    websiteUrl: text('website_url'),
    logoUrl: text('logo_url'),
    status: charityStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [idCheck('charities_id_prefix', table.id, 'chr'), uniqueIndex('charities_slug_key').on(table.slug)],
);

export type Charity = typeof charities.$inferSelect;
export type NewCharity = typeof charities.$inferInsert;

// ---- Tournaments ------------------------------------------------------------------------

/**
 * Event metadata plus the Purse contest reference. The contest itself (asset, entry
 * amount, prize structure, escrow) lives in Purse; `purse_contest_id` is set in phase 7
 * when the contest is created and `purse_external_id` is the opaque key Sideout mints so
 * the create call is idempotent. `draw_config` records the configuration the pools stage
 * was drawn with so the bracket stage reads it back rather than trusting a resend.
 */
export const tournaments = pgTable(
  'tournaments',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    subtitle: text('subtitle'),
    beneficiaryId: text('beneficiary_id')
      .notNull()
      .references(() => charities.id),
    venueName: text('venue_name').notNull(),
    venueCity: text('venue_city').notNull(),
    venueRegion: text('venue_region').notNull(),
    /** IANA zone of the venue, so schedule times render venue-local wherever the server runs. */
    venueTimezone: text('venue_timezone').notNull(),
    startsAt: tz('starts_at').notNull(),
    endsAt: tz('ends_at').notNull(),
    format: tournamentFormat('format').notNull(),
    division: division('division').notNull(),
    maxTeams: integer('max_teams').notNull(),
    /** The charitable entry donation per team, in cents of `donations.currency`. Zero means free entry. */
    entryDonationCents: cents('entry_donation_cents').notNull(),
    fundraisingGoalCents: cents('fundraising_goal_cents').notNull(),
    status: tournamentStatus('status').notNull().default('draft'),
    purseContestId: text('purse_contest_id'),
    purseExternalId: text('purse_external_id').notNull(),
    /** The contest's state as Purse last reported it (a response or a webhook); a mirror, never authoritative. */
    purseContestState: text('purse_contest_state'),
    /** The frozen settlement preview the close page showed (`server/purse/close.ts`); cleared when Purse refuses its hash. */
    purseClosePreview: jsonb('purse_close_preview').$type<FrozenClosePreview>(),
    drawConfig: jsonb('draw_config').$type<DrawConfig>(),
    ...timestamps,
  },
  (table) => [
    idCheck('tournaments_id_prefix', table.id, 'trn'),
    uniqueIndex('tournaments_slug_key').on(table.slug),
    uniqueIndex('tournaments_purse_external_id_key').on(table.purseExternalId),
    index('tournaments_status_idx').on(table.status),
    index('tournaments_beneficiary_idx').on(table.beneficiaryId),
    check('tournaments_slug_shape', sql`${table.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check('tournaments_max_teams_min', sql`${table.maxTeams} >= 2`),
    check('tournaments_entry_donation_nonneg', sql`${table.entryDonationCents} >= 0`),
    check('tournaments_goal_nonneg', sql`${table.fundraisingGoalCents} >= 0`),
    check('tournaments_ends_after_start', sql`${table.endsAt} >= ${table.startsAt}`),
  ],
);

export type Tournament = typeof tournaments.$inferSelect;
export type NewTournament = typeof tournaments.$inferInsert;

/**
 * Sponsors are event metadata for the Impact tab. `prize_contribution_cents` is the
 * value a sponsor has put up toward goods-redeemable prizes; the prize itself is funded
 * in Purse as `CREDIT` in phase 7. It is never summed with, joined to, or displayed as a
 * donation (spec acceptance criterion 21).
 */
export const sponsors = pgTable(
  'sponsors',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    tier: sponsorTier('tier').notNull(),
    prizeContributionCents: cents('prize_contribution_cents').notNull(),
    ...timestamps,
  },
  (table) => [
    idCheck('sponsors_id_prefix', table.id, 'spn'),
    index('sponsors_tournament_idx').on(table.tournamentId),
    check('sponsors_contribution_nonneg', sql`${table.prizeContributionCents} >= 0`),
  ],
);

export type Sponsor = typeof sponsors.$inferSelect;
export type NewSponsor = typeof sponsors.$inferInsert;

// ---- Teams ------------------------------------------------------------------------------

/**
 * `seed` is the organizer-assigned entry seed, persisted only from an explicit seeds list
 * and never touched by a draw; bracket ordering derived from pool standings is stored on
 * the bracket match rows instead. `invited_phone_e164` is the partner the captain named;
 * they join by signing in with that number.
 */
export const teams = pgTable(
  'teams',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    name: text('name').notNull(),
    seed: integer('seed'),
    status: teamStatus('status').notNull().default('forming'),
    invitedPhoneE164: text('invited_phone_e164'),
    registeredAt: tz('registered_at'),
    ...timestamps,
  },
  (table) => [
    idCheck('teams_id_prefix', table.id, 'tm'),
    index('teams_tournament_idx').on(table.tournamentId),
    uniqueIndex('teams_tournament_seed_key').on(table.tournamentId, table.seed),
    check('teams_seed_positive', sql`${table.seed} IS NULL OR ${table.seed} >= 1`),
    check(
      'teams_invited_phone_shape',
      sql`${table.invitedPhoneE164} IS NULL OR ${table.invitedPhoneE164} ~ ${sql.raw(`'${PHONE_E164_PATTERN}'`)}`,
    ),
  ],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

/**
 * Exactly two members, one captain. A row-count rule is not a column CHECK, so it is
 * enforced by `domain/team.ts` inside every transaction that changes a roster, and the
 * seed invariant tests prove the seeded rows obey it.
 */
export const teamMembers = pgTable(
  'team_members',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: teamRole('role').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('team_members_id_prefix', table.id, 'tmm'),
    uniqueIndex('team_members_team_user_key').on(table.teamId, table.userId),
    index('team_members_user_idx').on(table.userId),
  ],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;

/**
 * Signed score attestation (spec section 12, item 1; `docs/attestation.md`): a team member's
 * phone, registered at check-in. The browser generates a non-extractable P-256 key pair
 * and registers the public half here for the team; `key_id` is its JWK thumbprint, computed
 * server side. A scoreline submitted from that phone carries a signature the server checks
 * against this row before the consensus sees it, and the same key is mirrored to Purse for
 * the member's linked user (`purse_device_id`) so Purse can verify again on its own. The
 * organizer may revoke a device; a revocation is never undone, and a lost or replaced phone
 * registers again as a new row (one live row per key per team).
 */
export const teamDevices = pgTable(
  'team_devices',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull().default('ES256'),
    publicKey: jsonb('public_key').$type<EcPublicJwk>().notNull(),
    /** The Purse device (`udv_`) this key was mirrored as for the member's linked user; null until the mirror lands. */
    purseDeviceId: text('purse_device_id'),
    purseMirroredAt: tz('purse_mirrored_at'),
    revokedAt: tz('revoked_at'),
    revokedByUserId: text('revoked_by_user_id').references(() => users.id),
    revokedReason: text('revoked_reason'),
    ...timestamps,
  },
  (table) => [
    idCheck('team_devices_id_prefix', table.id, 'dev'),
    check('team_devices_key_id_shape', sql`${table.keyId} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('team_devices_algorithm', sql`${table.algorithm} in ('ES256')`),
    check('team_devices_revoked_pair', sql`(${table.revokedAt} IS NULL) = (${table.revokedByUserId} IS NULL)`),
    uniqueIndex('team_devices_live_key').on(table.teamId, table.keyId).where(sql`${table.revokedAt} IS NULL`),
    index('team_devices_team_idx').on(table.teamId),
    index('team_devices_user_idx').on(table.userId),
  ],
);

export type TeamDevice = typeof teamDevices.$inferSelect;
export type NewTeamDevice = typeof teamDevices.$inferInsert;

// ---- Pools and matches ------------------------------------------------------------------

export const pools = pgTable(
  'pools',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    /** Display label, `Pool A`. */
    label: text('label').notNull(),
    /** Zero-based order of the pool in the draw. */
    sequence: integer('sequence').notNull(),
    courtLabel: text('court_label').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('pools_id_prefix', table.id, 'pol'),
    index('pools_tournament_idx').on(table.tournamentId),
    uniqueIndex('pools_tournament_label_key').on(table.tournamentId, table.label),
    uniqueIndex('pools_tournament_sequence_key').on(table.tournamentId, table.sequence),
  ],
);

export type Pool = typeof pools.$inferSelect;
export type NewPool = typeof pools.$inferInsert;

/** Membership of a pool. A team is in at most one pool per draw; a redraw replaces the rows. */
export const poolTeams = pgTable(
  'pool_teams',
  {
    id: text('id').primaryKey(),
    poolId: text('pool_id')
      .notNull()
      .references(() => pools.id),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    /** One-based slot within the pool in snake-seeding order. */
    position: integer('position').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('pool_teams_id_prefix', table.id, 'plt'),
    uniqueIndex('pool_teams_pool_team_key').on(table.poolId, table.teamId),
    uniqueIndex('pool_teams_pool_position_key').on(table.poolId, table.position),
    uniqueIndex('pool_teams_team_key').on(table.teamId),
    check('pool_teams_position_positive', sql`${table.position} >= 1`),
  ],
);

export type PoolTeam = typeof poolTeams.$inferSelect;
export type NewPoolTeam = typeof poolTeams.$inferInsert;

/**
 * A match is either a pool match (`pool_id` set) or a bracket match (`bracket_position`
 * set), never both. Bracket rows carry `next_match_id`/`next_match_slot` so advancement is
 * a lookup, and `team_a_seed`/`team_b_seed` hold the bracket seed each slot was drawn
 * with. `final` is written only by phase 7's consensus (`domain/state.ts`); `forfeited`
 * and `bye` are the two other ways a match ends.
 */
export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    poolId: text('pool_id').references(() => pools.id),
    round: integer('round').notNull(),
    bracketPosition: integer('bracket_position'),
    courtLabel: text('court_label'),
    teamAId: text('team_a_id').references(() => teams.id),
    teamBId: text('team_b_id').references(() => teams.id),
    teamASeed: integer('team_a_seed'),
    teamBSeed: integer('team_b_seed'),
    bestOf: integer('best_of').notNull(),
    status: matchStatus('status').notNull().default('scheduled'),
    winnerTeamId: text('winner_team_id').references(() => teams.id),
    nextMatchId: text('next_match_id').references((): AnyPgColumn => matches.id),
    nextMatchSlot: matchSlot('next_match_slot'),
    scheduledAt: tz('scheduled_at'),
    startedAt: tz('started_at'),
    finalizedAt: tz('finalized_at'),
    ...timestamps,
  },
  (table) => [
    idCheck('matches_id_prefix', table.id, 'mch'),
    index('matches_tournament_idx').on(table.tournamentId),
    index('matches_pool_idx').on(table.poolId),
    index('matches_status_idx').on(table.status),
    index('matches_next_match_idx').on(table.nextMatchId),
    uniqueIndex('matches_tournament_bracket_position_key').on(table.tournamentId, table.bracketPosition),
    check('matches_round_positive', sql`${table.round} >= 1`),
    check('matches_best_of_values', sql`${table.bestOf} IN (1, 3)`),
    check(
      'matches_pool_xor_bracket',
      sql`(${table.poolId} IS NOT NULL AND ${table.bracketPosition} IS NULL) OR (${table.poolId} IS NULL AND ${table.bracketPosition} IS NOT NULL)`,
    ),
    check(
      'matches_distinct_teams',
      sql`${table.teamAId} IS NULL OR ${table.teamBId} IS NULL OR ${table.teamAId} <> ${table.teamBId}`,
    ),
    check(
      'matches_winner_is_participant',
      sql`${table.winnerTeamId} IS NULL OR ${table.winnerTeamId} = ${table.teamAId} OR ${table.winnerTeamId} = ${table.teamBId}`,
    ),
    check(
      'matches_bye_shape',
      sql`${table.status} <> 'bye' OR (${table.teamAId} IS NOT NULL AND ${table.teamBId} IS NULL AND ${table.winnerTeamId} = ${table.teamAId})`,
    ),
    check('matches_next_slot_with_next', sql`(${table.nextMatchId} IS NULL) = (${table.nextMatchSlot} IS NULL)`),
  ],
);

export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;

/**
 * Set scores, always oriented from team A's side. Written by phase 7's consensus (and by
 * the seed); `agreed` records that both teams' submissions matched.
 */
export const sets = pgTable(
  'sets',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id),
    setNumber: integer('set_number').notNull(),
    teamAPoints: integer('team_a_points').notNull(),
    teamBPoints: integer('team_b_points').notNull(),
    agreed: boolean('agreed').notNull().default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('sets_id_prefix', table.id, 'set'),
    uniqueIndex('sets_match_set_number_key').on(table.matchId, table.setNumber),
    check('sets_set_number_range', sql`${table.setNumber} BETWEEN 1 AND 3`),
    check('sets_points_nonneg', sql`${table.teamAPoints} >= 0 AND ${table.teamBPoints} >= 0`),
  ],
);

export type SetRow = typeof sets.$inferSelect;
export type NewSetRow = typeof sets.$inferInsert;

// ---- Donations (the only real dollars) --------------------------------------------------

/**
 * Charitable donations, processed by Stripe (or the dev provider outside production),
 * reconciled against the provider's own reporting. This is the only table in either
 * service whose currency is a real one, and it has no foreign key to, and no query or
 * code path shared with, anything Purse-related (spec 4.2.6, acceptance criterion 21).
 * `amount_cents` is strictly positive; a refund is never a negative row. A full refund is
 * the `refunded` status; a partial one leaves the status `succeeded` and records the
 * running total in `refunded_cents`, so what a donation still counts for is
 * `amount_cents - refunded_cents`.
 */
export const donations = pgTable(
  'donations',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    teamId: text('team_id').references(() => teams.id),
    userId: text('user_id').references(() => users.id),
    amountCents: cents('amount_cents').notNull(),
    /** ISO 4217, uppercase. */
    currency: text('currency').notNull(),
    provider: donationProvider('provider').notNull(),
    /** The provider's own id for the payment (a Stripe PaymentIntent id, or a dev reference). */
    providerRef: text('provider_ref').notNull(),
    status: donationStatus('status').notNull().default('pending'),
    /** Cents the provider has refunded so far, in `currency`; never more than `amount_cents`. */
    refundedCents: cents('refunded_cents').notNull().default(sql`0`),
    /** The provider's reason for the most recent declined attempt; describes the payment while it is still pending. */
    lastPaymentError: text('last_payment_error'),
    ...timestamps,
  },
  (table) => [
    idCheck('donations_id_prefix', table.id, 'don'),
    index('donations_tournament_idx').on(table.tournamentId),
    index('donations_team_idx').on(table.teamId),
    index('donations_status_idx').on(table.status),
    uniqueIndex('donations_provider_ref_key').on(table.provider, table.providerRef),
    check('donations_amount_positive', sql`${table.amountCents} > 0`),
    check('donations_refunded_within_amount', sql`${table.refundedCents} >= 0 AND ${table.refundedCents} <= ${table.amountCents}`),
    check('donations_currency_shape', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export type Donation = typeof donations.$inferSelect;
export type NewDonation = typeof donations.$inferInsert;

/**
 * Every provider event applied to a donation, keyed on the provider's event id, which is
 * what makes the Stripe webhook receiver idempotent: a redelivered event is recognised
 * and acknowledged without touching the donation again.
 */
export const donationProviderEvents = pgTable(
  'donation_provider_events',
  {
    id: text('id').primaryKey(),
    provider: donationProvider('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    donationId: text('donation_id').references(() => donations.id),
    receivedAt: tz('received_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('donation_provider_events_id_prefix', table.id, 'dpe'),
    uniqueIndex('donation_provider_events_provider_event_key').on(table.provider, table.eventId),
  ],
);

export type DonationProviderEvent = typeof donationProviderEvents.$inferSelect;

// ---- Score consensus (the trust boundary, spec 5.2) --------------------------------------

/**
 * One row per scoreline a person submitted for a match, exactly as they typed it (their
 * own points first, `perspective` saying which team "us" was) plus the hash of its
 * canonical form. Never updated, only superseded: a team's second reading sets
 * `superseded_by_id` on its first, and the first stays as the record. `submitted_for_team_id`
 * is resolved from `team_members` in the query, never trusted from the client (rule 2);
 * it is null for an organizer's resolution.
 */
export const scoreSubmissions = pgTable(
  'score_submissions',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id),
    submittedByUserId: text('submitted_by_user_id')
      .notNull()
      .references(() => users.id),
    submittedForTeamId: text('submitted_for_team_id').references(() => teams.id),
    perspective: submissionPerspective('perspective').notNull(),
    sets: jsonb('sets').$type<SubmittedSet[]>().notNull(),
    /** SHA-256 of the canonical, match-oriented scoreline (`domain/scoreline-hash.ts`). */
    hash: text('hash').notNull(),
    /**
     * The device signature over this scoreline, verified against the team's registered
     * device before the row was written (`server/attestation.ts`), or null for an unsigned
     * submission and an organizer's resolution. Fixed at insert like the rest of the row.
     */
    attestation: jsonb('attestation').$type<StoredAttestation>(),
    supersededById: text('superseded_by_id').references((): AnyPgColumn => scoreSubmissions.id),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('score_submissions_id_prefix', table.id, 'ssb'),
    index('score_submissions_match_idx').on(table.matchId),
    index('score_submissions_team_idx').on(table.submittedForTeamId),
    check('score_submissions_hash_shape', sql`${table.hash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type ScoreSubmission = typeof scoreSubmissions.$inferSelect;
export type NewScoreSubmission = typeof scoreSubmissions.$inferInsert;

/**
 * The consensus of one match: its state, what was agreed, why it is disputed, who
 * resolved it, and the one idempotency key minted when it first reached `agreed`, reused
 * by every Purse attempt for the match (rule 4). Every transition writes `audit_log`.
 */
export const matchConsensus = pgTable(
  'match_consensus',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id),
    state: consensusState('state').notNull().default('awaiting_first'),
    /** Hash of the agreed scoreline; the agreed sets themselves are the match's `sets` rows with `agreed = true`. */
    agreedHash: text('agreed_hash'),
    /** Neutral wording of what differs, for the dispute queue; never who is wrong. */
    disputedReason: text('disputed_reason'),
    /** The differing sets, match-oriented, `a` being team A's reading and `b` team B's. */
    disputedSets: jsonb('disputed_sets').$type<SetDifference[]>(),
    resolvedByUserId: text('resolved_by_user_id').references(() => users.id),
    idempotencyKey: text('idempotency_key'),
    pushedAt: tz('pushed_at'),
    confirmedAt: tz('confirmed_at'),
    /** The last Purse refusal or failure, as the organizer's retry queue shows it; cleared when a push lands. */
    lastPushError: jsonb('last_push_error').$type<{ type: string; code: string; message: string; at: string }>(),
    ...timestamps,
  },
  (table) => [
    idCheck('match_consensus_id_prefix', table.id, 'mcs'),
    uniqueIndex('match_consensus_match_key').on(table.matchId),
    uniqueIndex('match_consensus_idempotency_key').on(table.idempotencyKey),
    index('match_consensus_state_idx').on(table.state),
    check('match_consensus_agreed_hash_shape', sql`${table.agreedHash} IS NULL OR ${table.agreedHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'match_consensus_key_once_agreed',
      sql`${table.state} IN ('awaiting_first', 'awaiting_second', 'disputed') OR ${table.idempotencyKey} IS NOT NULL`,
    ),
  ],
);

export type MatchConsensus = typeof matchConsensus.$inferSelect;
export type NewMatchConsensus = typeof matchConsensus.$inferInsert;

// ---- The Purse integration -------------------------------------------------------------

/**
 * Which players Purse holds as entrants of a tournament's contest, as read back from the
 * contest (`POST /api/teams/:id/purse/entries`) or announced by `contest.entry.created`.
 * Keyed by the Purse user id so a participant Sideout cannot match to a local player (an
 * "extra") is still recorded and shown to the organizer.
 */
export const purseEntries = pgTable(
  'purse_entries',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    purseUserId: text('purse_user_id').notNull(),
    /** The local player, when the Purse user is linked to one. */
    userId: text('user_id').references(() => users.id),
    purseParticipantId: text('purse_participant_id').notNull(),
    state: purseEntryState('state').notNull().default('entered'),
    /** `read_back` (the contest was read) or `webhook` (an event announced it). */
    source: text('source').notNull(),
    ...timestamps,
  },
  (table) => [
    idCheck('purse_entries_id_prefix', table.id, 'pen'),
    uniqueIndex('purse_entries_tournament_user_key').on(table.tournamentId, table.purseUserId),
    index('purse_entries_user_idx').on(table.userId),
  ],
);

export type PurseEntry = typeof purseEntries.$inferSelect;
export type NewPurseEntry = typeof purseEntries.$inferInsert;

/**
 * Every request Sideout makes to Purse and what came back (spec 5.1, the `/admin/purse`
 * page): written before the call as `in_flight` and completed after it. The secret key is
 * never stored (headers are not recorded and bodies are scrubbed of anything key-shaped).
 * A row that stays `in_flight` is a call whose process died before Purse answered.
 */
export const purseCalls = pgTable(
  'purse_calls',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    idempotencyKey: text('idempotency_key'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    requestBody: jsonb('request_body'),
    status: purseCallStatus('status').notNull().default('in_flight'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    /** Why no response arrived (a refused connection, a timeout, a malformed body). */
    error: text('error'),
    /** True when Purse answered from its idempotency store rather than performing the request again. */
    replayed: boolean('replayed'),
    startedAt: tz('started_at').notNull(),
    finishedAt: tz('finished_at'),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    idCheck('purse_calls_id_prefix', table.id, 'pcl'),
    index('purse_calls_started_idx').on(table.startedAt),
    index('purse_calls_subject_idx').on(table.subjectType, table.subjectId),
    index('purse_calls_idempotency_key_idx').on(table.idempotencyKey),
  ],
);

export type PurseCall = typeof purseCalls.$inferSelect;
export type NewPurseCall = typeof purseCalls.$inferInsert;

/**
 * Every webhook event Purse delivered, keyed on the event id, which is what makes the
 * receiver idempotent: a redelivery (Purse retries, and replays are the same event) is
 * recognised and acknowledged without being applied again.
 */
export const purseWebhookEvents = pgTable(
  'purse_webhook_events',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    /** `applied`, `ignored` (an unknown type or an unknown subject) or the reason it could not be applied. */
    outcome: text('outcome').notNull(),
    receivedAt: tz('received_at').notNull().defaultNow(),
  },
  (table) => [idCheck('purse_webhook_events_id_prefix', table.id, 'pwe'), uniqueIndex('purse_webhook_events_event_id_key').on(table.eventId)],
);

export type PurseWebhookEvent = typeof purseWebhookEvents.$inferSelect;

// ---- Audit ------------------------------------------------------------------------------

/**
 * Every state transition Sideout performs, with who did it. Append-only by convention;
 * the services write a row in the same transaction as the change it records.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorKind: actorKind('actor_kind').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id),
    /** Dotted verb, e.g. `tournament.status_changed`, `match.forfeited`. */
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    idCheck('audit_log_id_prefix', table.id, 'aud'),
    index('audit_log_subject_idx').on(table.subjectType, table.subjectId),
    index('audit_log_created_idx').on(table.createdAt),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
