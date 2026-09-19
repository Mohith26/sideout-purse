/**
 * The ping-pong ladder's schema: only what Purse does not own (system spec section 2,
 * rule 1). Players and their Purse link (decision D8: the app authenticates its own
 * people and links each to a Purse user by an opaque external id), seasons (one Purse
 * contest each), the ladder (one `season_entries` row per entrant, holding their rank
 * and record), the challenges and results (`ladder_matches`), and the Purse call audit
 * (`purse_calls`, every request and response, bodies redacted).
 *
 * Conventions (shared with Purse and Sideout through `@repo/db`):
 * - Ids are typed-prefix UUID v7 strings checked at the database; every prefix is
 *   registered in `@repo/ids`, nowhere else.
 * - Timestamps are `timestamptz`.
 * - Enumerations are Postgres enums, not free text, so the database rejects a typo.
 * - No column holds contest value: what Purse said is kept verbatim as an audit
 *   (`purse_calls.response_body`, a season's frozen close preview and its settlement),
 *   never summed or displayed as money this app holds.
 * - Purse objects are referenced by opaque `purse_*` id columns, never by foreign key.
 * - The ladder's row-count rules (ranks are 1..n without gaps, one open match per player)
 *   live in `domain/ladder.ts` and are enforced by the services under the season's row
 *   lock, inside the transaction that writes the rows.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { idCheck, timestamps } from '@repo/db';

import type { FrozenClosePreview, SeasonSettlement } from '../domain/close-preview';

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** A player's name key: lowercase words joined by single hyphens, e.g. `ada-lovelace`. */
export const NAME_KEY_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';

// ---- Enumerations ----------------------------------------------------------------------

/**
 * A season's life: `enrolling` (the Purse contest is open; players enter), `playing`
 * (locked and in progress on Purse; challenges and results), `closing` (the final scores
 * are pushed and the preview frozen; nothing more is played) and `closed` (settled).
 */
export const seasonStatus = pgEnum('season_status', ['enrolling', 'playing', 'closing', 'closed']);
export const SEASON_STATUSES = seasonStatus.enumValues;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

/**
 * A match's life: `challenged` (issued, not yet played), `reported` (one side entered a
 * scoreline; the other must confirm), `confirmed` (both agree: the ladder moved and the
 * result counts) and `declined` (the defender declined the challenge).
 */
export const matchStatus = pgEnum('ladder_match_status', ['challenged', 'reported', 'confirmed', 'declined']);
export const MATCH_STATUSES = matchStatus.enumValues;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const purseCallStatus = pgEnum('purse_call_status', ['in_flight', 'succeeded', 'refused', 'failed']);
export const PURSE_CALL_STATUSES = purseCallStatus.enumValues;
export type PurseCallStatus = (typeof PURSE_CALL_STATUSES)[number];

// ---- Players -----------------------------------------------------------------------------

export const players = pgTable(
  'players',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** The sign-in key: the name, normalised. Two people with the same name are one player; this is an office. */
    nameKey: text('name_key').notNull(),
    /** The opaque id this player is known to Purse by; minted once, never shown. */
    purseExternalId: text('purse_external_id').notNull(),
    purseUserId: text('purse_user_id'),
    purseLinkedAt: tz('purse_linked_at'),
    ...timestamps,
  },
  (table) => [
    idCheck('players_id_prefix', table.id, 'ppl'),
    uniqueIndex('players_name_key_idx').on(table.nameKey),
    uniqueIndex('players_purse_external_id_idx').on(table.purseExternalId),
    uniqueIndex('players_purse_user_id_idx').on(table.purseUserId),
    check('players_name_key_shape', sql`${table.nameKey} ~ ${sql.raw(`'${NAME_KEY_PATTERN}'`)}`),
    check('players_name_length', sql`char_length(${table.name}) between 1 and 40`),
  ],
);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;

// ---- Seasons -----------------------------------------------------------------------------

export const seasons = pgTable(
  'seasons',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: seasonStatus('status').notNull().default('enrolling'),
    /** The player who opened the season; the one who may start and close it. */
    commissionerId: text('commissioner_id')
      .notNull()
      .references(() => players.id),
    /** The `external_id` the season's Purse contest is created under; minted once. */
    purseExternalId: text('purse_external_id').notNull(),
    purseContestId: text('purse_contest_id'),
    /** What Purse last said the contest's state was: a mirror, never authoritative. */
    purseContestState: text('purse_contest_state'),
    /** The frozen close preview (step 1 of the two-step close); cleared when Purse refuses its hash. */
    purseClosePreview: jsonb('purse_close_preview').$type<FrozenClosePreview>(),
    /** What Purse settled, verbatim, once the season is closed. */
    purseSettlement: jsonb('purse_settlement').$type<SeasonSettlement>(),
    startedAt: tz('started_at'),
    closedAt: tz('closed_at'),
    ...timestamps,
  },
  (table) => [
    idCheck('seasons_id_prefix', table.id, 'ssn'),
    uniqueIndex('seasons_purse_external_id_idx').on(table.purseExternalId),
    index('seasons_status_idx').on(table.status),
  ],
);

export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;

/** One row per player Purse holds as an entrant: the ladder. Ranks are 1..n; the domain keeps them gapless. */
export const seasonEntries = pgTable(
  'season_entries',
  {
    id: text('id').primaryKey(),
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    rank: integer('rank').notNull(),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    /** The Purse participant this entry mirrors (read back from the contest, never assumed). */
    purseParticipantId: text('purse_participant_id').notNull(),
    enteredAt: tz('entered_at').notNull(),
    ...timestamps,
  },
  (table) => [
    idCheck('season_entries_id_prefix', table.id, 'sne'),
    uniqueIndex('season_entries_season_player_idx').on(table.seasonId, table.playerId),
    index('season_entries_season_rank_idx').on(table.seasonId, table.rank),
    check('season_entries_rank_positive', sql`${table.rank} >= 1`),
    check('season_entries_record_non_negative', sql`${table.wins} >= 0 and ${table.losses} >= 0`),
  ],
);

export type SeasonEntry = typeof seasonEntries.$inferSelect;

// ---- Matches -----------------------------------------------------------------------------

export const ladderMatches = pgTable(
  'ladder_matches',
  {
    id: text('id').primaryKey(),
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id),
    challengerId: text('challenger_id')
      .notNull()
      .references(() => players.id),
    defenderId: text('defender_id')
      .notNull()
      .references(() => players.id),
    status: matchStatus('status').notNull().default('challenged'),
    challengerScore: integer('challenger_score'),
    defenderScore: integer('defender_score'),
    reportedById: text('reported_by_id').references(() => players.id),
    reportedAt: tz('reported_at'),
    confirmedById: text('confirmed_by_id').references(() => players.id),
    confirmedAt: tz('confirmed_at'),
    winnerId: text('winner_id').references(() => players.id),
    /** True when the challenger won and took the defender's place. */
    ladderMoved: boolean('ladder_moved'),
    /** The key the confirmed result's score batch is pushed to Purse under; minted once at confirmation. */
    purseIdempotencyKey: text('purse_idempotency_key'),
    pursePushedAt: tz('purse_pushed_at'),
    pursePushError: jsonb('purse_push_error').$type<{ type: string; code: string; message: string; at: string }>(),
    ...timestamps,
  },
  (table) => [
    idCheck('ladder_matches_id_prefix', table.id, 'lmt'),
    index('ladder_matches_season_idx').on(table.seasonId, table.status),
    check('ladder_matches_distinct_players', sql`${table.challengerId} <> ${table.defenderId}`),
    check('ladder_matches_scores_non_negative', sql`(${table.challengerScore} is null or ${table.challengerScore} >= 0) and (${table.defenderScore} is null or ${table.defenderScore} >= 0)`),
  ],
);

export type LadderMatch = typeof ladderMatches.$inferSelect;

// ---- The Purse call audit -----------------------------------------------------------------

/** Every request to Purse: written before it leaves, completed when it returns; bodies redacted of anything key-shaped. */
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
    idCheck('purse_calls_id_prefix', table.id, 'ppc'),
    index('purse_calls_started_idx').on(table.startedAt),
    index('purse_calls_subject_idx').on(table.subjectType, table.subjectId),
  ],
);

export type PurseCall = typeof purseCalls.$inferSelect;
