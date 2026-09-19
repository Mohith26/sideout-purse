import { and, asc, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { newId } from '@repo/ids';
import { z } from 'zod';

import type { Db } from '../db/client';
import {
  charities,
  DIVISIONS,
  donations,
  matches,
  pools,
  poolTeams,
  sponsors,
  teamMembers,
  teams,
  TOURNAMENT_STATUSES,
  tournaments,
  users,
  type Tournament,
  type TournamentStatus,
} from '../db/schema';
import { DRAWABLE_FORMATS, MAX_FIELD_SIZE } from '../domain/draw';
import { isMatchComplete, validateTournamentTransition } from '../domain/state';
import { mintPurseExternalId, type Actor } from './actor';
import { writeAudit } from './audit';
import type { DbOrTx } from './db';
import { deleteDraw } from './draw';
import { COUNTED_TEAM_STATUSES, confirmedTeam, countedTeams, countedTeamsFilter, placeHoldingTeam, reservationExpiresAt, type ReservationClock } from './field';
import { failure } from './http/errors';
import { emitLive, liveTransaction } from './live/outbox';
import { centsSchema } from './money';
import {
  toPublicMatch,
  toPublicPool,
  toPublicSponsor,
  toPublicTeam,
  toPublicTournament,
  type PublicMatch,
  type PublicTournament,
  type PublicTournamentDetail,
} from './public-shape';
import { loadPoolStage, publicStandings } from './standings';

const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const timezone = z.string().min(1).refine((zone) => isValidTimezone(zone), 'must be an IANA time zone');

function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const createTournamentSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase words joined by hyphens').min(3).max(64),
    name: z.string().trim().min(3).max(120),
    subtitle: z.string().trim().max(200).optional(),
    beneficiaryId: z.string().startsWith('chr_'),
    venue: z.object({ name: z.string().trim().min(1).max(120), city: z.string().trim().min(1).max(80), region: z.string().trim().min(1).max(80), timezone }),
    startsAt: isoDate,
    endsAt: isoDate,
    /** Only formats the engine can draw are offered; `double_elim` stays in the enum for the follow-up. */
    format: z.enum(DRAWABLE_FORMATS),
    division: z.enum(DIVISIONS),
    maxTeams: z.number().int().min(2).max(MAX_FIELD_SIZE),
    entryDonationCents: centsSchema,
    fundraisingGoalCents: centsSchema,
  })
  .refine((value) => value.endsAt.getTime() >= value.startsAt.getTime(), { message: 'endsAt must not be before startsAt', path: ['endsAt'] });

export type CreateTournamentInput = z.infer<typeof createTournamentSchema>;

export async function createTournament(db: Db, input: CreateTournamentInput, actor: Actor, now: Date): Promise<Tournament> {
  return db.transaction(async (tx) => {
    const [beneficiary] = await tx.select().from(charities).where(eq(charities.id, input.beneficiaryId));
    if (beneficiary?.status !== 'active') {
      throw failure.invalidRequest('beneficiary_unknown', 'The beneficiary must be an active charity.');
    }
    const [existing] = await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.slug, input.slug));
    if (existing !== undefined) throw failure.conflict('slug_taken', `A tournament with slug "${input.slug}" already exists.`);

    const [row] = await tx
      .insert(tournaments)
      .values({
        id: newId('trn'),
        slug: input.slug,
        name: input.name,
        subtitle: input.subtitle ?? null,
        beneficiaryId: input.beneficiaryId,
        venueName: input.venue.name,
        venueCity: input.venue.city,
        venueRegion: input.venue.region,
        venueTimezone: input.venue.timezone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        format: input.format,
        division: input.division,
        maxTeams: input.maxTeams,
        entryDonationCents: input.entryDonationCents,
        fundraisingGoalCents: input.fundraisingGoalCents,
        status: 'draft',
        purseExternalId: mintPurseExternalId('contest'),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (row === undefined) throw new Error('tournament insert returned no row');
    await writeAudit(tx, {
      actor,
      action: 'tournament.created',
      subjectType: 'tournament',
      subjectId: row.id,
      detail: { slug: row.slug, format: row.format, status: row.status },
      at: now,
    });
    return row;
  });
}

// ---- Update and status transitions -----------------------------------------------------

export const updateTournamentSchema = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    subtitle: z.string().trim().max(200).nullable().optional(),
    beneficiaryId: z.string().startsWith('chr_').optional(),
    venue: z
      .object({ name: z.string().trim().min(1).max(120), city: z.string().trim().min(1).max(80), region: z.string().trim().min(1).max(80), timezone })
      .optional(),
    startsAt: isoDate.optional(),
    endsAt: isoDate.optional(),
    format: z.enum(DRAWABLE_FORMATS).optional(),
    division: z.enum(DIVISIONS).optional(),
    maxTeams: z.number().int().min(2).max(MAX_FIELD_SIZE).optional(),
    entryDonationCents: centsSchema.optional(),
    fundraisingGoalCents: centsSchema.optional(),
    status: z.enum(TOURNAMENT_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });

export type UpdateTournamentInput = z.infer<typeof updateTournamentSchema>;

/** Fields that reshape the event; only a draft may change them. */
const DRAFT_ONLY_FIELDS = ['beneficiaryId', 'format', 'division', 'entryDonationCents'] as const;

export type UpdateResult = { tournament: Tournament; changedFields: string[]; transition: { from: TournamentStatus; to: TournamentStatus } | null };

/**
 * Edit fields, then apply a status change, in one transaction. Moving `startsAt` shifts
 * every scheduled match by the same delta, because their times were derived from it at
 * draw time and a derived figure must not go stale; once a match has started the start
 * time is fixed.
 */
export async function updateTournament(db: Db, id: string, input: UpdateTournamentInput, actor: Actor, clock: ReservationClock): Promise<UpdateResult> {
  const now = clock.now;
  return liveTransaction(db, async (tx) => {
    const [current] = await tx.select().from(tournaments).where(eq(tournaments.id, id)).for('update');
    if (current === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');

    const { status: nextStatus, ...fields } = input;
    const changedFields = Object.keys(fields).filter((key) => fields[key as keyof typeof fields] !== undefined);

    if (changedFields.length > 0) {
      if (current.status === 'settled' || current.status === 'cancelled') {
        throw failure.invalidState('tournament_closed', `A ${current.status} tournament cannot be edited.`);
      }
      const draftOnly = changedFields.filter((field) => (DRAFT_ONLY_FIELDS as readonly string[]).includes(field));
      if (draftOnly.length > 0 && current.status !== 'draft') {
        throw failure.invalidState('draft_only_fields', `Only a draft may change ${draftOnly.join(', ')}.`, { fields: draftOnly });
      }
      if (fields.beneficiaryId !== undefined) {
        const [beneficiary] = await tx.select().from(charities).where(eq(charities.id, fields.beneficiaryId));
        if (beneficiary?.status !== 'active') {
          throw failure.invalidRequest('beneficiary_unknown', 'The beneficiary must be an active charity.');
        }
      }
      if (fields.maxTeams !== undefined) {
        const registered = await countedTeams(tx, current.id, clock);
        if (fields.maxTeams < registered) {
          throw failure.invalidState('max_teams_below_registered', `${registered} teams are already registered; maxTeams cannot be ${fields.maxTeams}.`);
        }
      }
      const startsAt = fields.startsAt ?? current.startsAt;
      const endsAt = fields.endsAt ?? current.endsAt;
      if (endsAt.getTime() < startsAt.getTime()) throw failure.invalidRequest('ends_before_start', 'endsAt must not be before startsAt.');

      const shiftMs = startsAt.getTime() - current.startsAt.getTime();
      let rescheduled = 0;
      if (shiftMs !== 0) {
        const drawn = await tx.select({ id: matches.id, status: matches.status }).from(matches).where(eq(matches.tournamentId, current.id));
        const started = drawn.filter((m) => m.status !== 'scheduled' && m.status !== 'bye');
        if (started.length > 0) {
          throw failure.invalidState('schedule_in_play', `${started.length} match(es) have started; startsAt can no longer move.`, {
            matches: started.map((m) => ({ id: m.id, status: m.status })),
          });
        }
        const shifted = await tx
          .update(matches)
          .set({ scheduledAt: sql`${matches.scheduledAt} + (${shiftMs}::bigint * interval '1 millisecond')`, updatedAt: now })
          .where(and(eq(matches.tournamentId, current.id), isNotNull(matches.scheduledAt)))
          .returning({ id: matches.id });
        rescheduled = shifted.length;
      }

      await tx
        .update(tournaments)
        .set({
          ...(fields.name !== undefined ? { name: fields.name } : {}),
          ...(fields.subtitle !== undefined ? { subtitle: fields.subtitle } : {}),
          ...(fields.beneficiaryId !== undefined ? { beneficiaryId: fields.beneficiaryId } : {}),
          ...(fields.venue !== undefined
            ? { venueName: fields.venue.name, venueCity: fields.venue.city, venueRegion: fields.venue.region, venueTimezone: fields.venue.timezone }
            : {}),
          ...(fields.startsAt !== undefined ? { startsAt: fields.startsAt } : {}),
          ...(fields.endsAt !== undefined ? { endsAt: fields.endsAt } : {}),
          ...(fields.format !== undefined ? { format: fields.format } : {}),
          ...(fields.division !== undefined ? { division: fields.division } : {}),
          ...(fields.maxTeams !== undefined ? { maxTeams: fields.maxTeams } : {}),
          ...(fields.entryDonationCents !== undefined ? { entryDonationCents: fields.entryDonationCents } : {}),
          ...(fields.fundraisingGoalCents !== undefined ? { fundraisingGoalCents: fields.fundraisingGoalCents } : {}),
          updatedAt: now,
        })
        .where(eq(tournaments.id, id));
      await writeAudit(tx, {
        actor,
        action: 'tournament.updated',
        subjectType: 'tournament',
        subjectId: id,
        detail: { fields: changedFields, ...(shiftMs === 0 ? {} : { scheduleShiftMs: shiftMs, matchesRescheduled: rescheduled }) },
        at: now,
      });
    }

    let transition: UpdateResult['transition'] = null;
    if (nextStatus !== undefined) {
      transition = await transitionTournament(tx, { tournament: current, to: nextStatus, actor, clock });
    }

    const [updated] = await tx.select().from(tournaments).where(eq(tournaments.id, id));
    if (updated === undefined) throw new Error('tournament vanished mid-transaction');
    return { tournament: updated, changedFields, transition };
  });
}

/**
 * The single place a tournament's status changes. Validates the transition matrix for
 * the actor, applies the guards that depend on rows, and writes the audit row:
 *
 * - reopening registration discards the draw (the field is about to change; nothing can
 *   have been played while registration was closed);
 * - `live` needs a draw that covers exactly the teams holding a place: a confirmed team
 *   left out or a drawn team that has since withdrawn means a redraw, a team still paying
 *   means waiting for the payment or the lapse;
 * - `awaiting_settlement` needs every match complete, and for the formats that end in a
 *   bracket, the bracket drawn.
 *
 * Emits the `state` live event, so the caller's transaction must be a `liveTransaction`
 * (`server/live/outbox.ts`): the event goes out after that commit.
 */
export async function transitionTournament(
  tx: DbOrTx,
  input: { tournament: Tournament; to: TournamentStatus; actor: Actor; clock: ReservationClock },
): Promise<{ from: TournamentStatus; to: TournamentStatus }> {
  const { tournament, clock } = input;
  const now = clock.now;
  const from = tournament.status;
  const verdict = validateTournamentTransition(from, input.to, input.actor.kind);
  if (!verdict.ok) {
    const type = verdict.code === 'actor_not_permitted' ? failure.permission : failure.invalidState;
    throw type(`transition_${verdict.code}`, verdict.message, { from, to: input.to });
  }

  if (from === 'registration_closed' && input.to === 'registration_open') {
    const played = await tx
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(and(eq(matches.tournamentId, tournament.id), ne(matches.status, 'scheduled'), ne(matches.status, 'bye')));
    if (played.length > 0) {
      throw failure.invalidState('draw_already_in_play', `${played.length} match(es) have started; registration cannot reopen.`, {
        matches: played.map((m) => ({ id: m.id, status: m.status })),
      });
    }
    const discarded = await deleteDraw(tx, tournament.id);
    if (discarded.matches > 0 || discarded.pools > 0) {
      await tx.update(tournaments).set({ drawConfig: null, updatedAt: now }).where(eq(tournaments.id, tournament.id));
      await writeAudit(tx, {
        actor: input.actor,
        action: 'tournament.draw_discarded',
        subjectType: 'tournament',
        subjectId: tournament.id,
        detail: { reason: 'registration_reopened', pools: discarded.pools, matches: discarded.matches },
        at: now,
      });
    }
  }

  if (input.to === 'live') {
    const [drawn] = await tx.select({ n: count() }).from(matches).where(eq(matches.tournamentId, tournament.id));
    if ((drawn?.n ?? 0) === 0) throw failure.invalidState('draw_required', 'Draw the tournament before going live.');
    const { notDrawn, withdrawnFromDraw, unpaid } = await teamsOutsideDraw(tx, tournament.id, clock);
    if (notDrawn.length > 0) {
      throw failure.invalidState('teams_not_drawn', `${notDrawn.length} confirmed team(s) are not in the draw: ${notDrawn.map((t) => t.name).join(', ')}. Redraw first.`, {
        teams: notDrawn,
      });
    }
    if (withdrawnFromDraw.length > 0) {
      throw failure.invalidState(
        'teams_withdrawn_from_draw',
        `${withdrawnFromDraw.length} drawn team(s) no longer hold a place: ${withdrawnFromDraw.map((t) => t.name).join(', ')}. Redraw first.`,
        { teams: withdrawnFromDraw },
      );
    }
    if (unpaid.length > 0) {
      throw failure.invalidState(
        'teams_unpaid',
        `${unpaid.length} team(s) are still paying for their place: ${unpaid.map((t) => `${t.name} (reservation expires ${t.reservationExpiresAt})`).join(', ')}. Wait for the payment, then redraw, or for the reservation to lapse.`,
        { teams: unpaid },
      );
    }
  }
  if (input.to === 'awaiting_settlement') {
    const open = await tx
      .select({ id: matches.id, status: matches.status, bracketPosition: matches.bracketPosition })
      .from(matches)
      .where(eq(matches.tournamentId, tournament.id));
    if (open.length === 0) throw failure.invalidState('no_matches', 'There are no matches to settle.');
    if (tournament.format !== 'round_robin' && !open.some((m) => m.bracketPosition !== null)) {
      throw failure.invalidState('bracket_not_drawn', 'The bracket has not been drawn; there is no champion to settle.');
    }
    const unresolved = open.filter((m) => !isMatchComplete(m.status));
    if (unresolved.length > 0) {
      throw failure.invalidState('matches_unresolved', `${unresolved.length} match(es) are not complete.`, {
        matches: unresolved.map((m) => ({ id: m.id, status: m.status })),
      });
    }
  }

  await tx.update(tournaments).set({ status: input.to, updatedAt: now }).where(eq(tournaments.id, tournament.id));
  await writeAudit(tx, {
    actor: input.actor,
    action: 'tournament.status_changed',
    subjectType: 'tournament',
    subjectId: tournament.id,
    detail: { from, to: input.to },
    at: now,
  });
  await emitLive(tx, { tournamentId: tournament.id, kind: 'state' });
  return { from, to: input.to };
}

type TeamsOutsideDraw = {
  /** Confirmed teams no pool and no round-1 bracket match includes: the draw is stale. */
  notDrawn: Array<{ id: string; name: string }>;
  /** Teams a pool or round-1 bracket match includes that hold no place any more: the draw is stale. */
  withdrawnFromDraw: Array<{ id: string; name: string }>;
  /** Teams whose reservation has not lapsed but whose payment has not landed: not drawable yet. */
  unpaid: Array<{ id: string; name: string; reservationExpiresAt: string }>;
};

async function teamsOutsideDraw(tx: DbOrTx, tournamentId: string, clock: ReservationClock): Promise<TeamsOutsideDraw> {
  const counted = await tx
    .select({ id: teams.id, name: teams.name, confirmed: sql<boolean>`${confirmedTeam()}` })
    .from(teams)
    .where(countedTeamsFilter(tournamentId, clock))
    .orderBy(asc(teams.createdAt));
  const inPools = await tx
    .select({ teamId: poolTeams.teamId })
    .from(poolTeams)
    .innerJoin(pools, eq(pools.id, poolTeams.poolId))
    .where(eq(pools.tournamentId, tournamentId));
  const inRoundOne = await tx
    .select({ teamAId: matches.teamAId, teamBId: matches.teamBId })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), isNotNull(matches.bracketPosition), eq(matches.round, 1)));
  const drawn = new Set([...inPools.map((r) => r.teamId), ...inRoundOne.flatMap((m) => [m.teamAId, m.teamBId])].filter((id): id is string => id !== null));
  const outside = counted.filter((team) => !drawn.has(team.id));
  const countedIds = new Set(counted.map((team) => team.id));
  const staleIds = [...drawn].filter((id) => !countedIds.has(id));
  const withdrawnFromDraw =
    staleIds.length === 0 ? [] : await tx.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, staleIds)).orderBy(asc(teams.createdAt));
  const reserving = outside.filter((team) => !team.confirmed);
  const reservations =
    reserving.length === 0
      ? []
      : await tx
          .select({ teamId: donations.teamId, createdAt: donations.createdAt })
          .from(donations)
          .where(and(inArray(donations.teamId, reserving.map((t) => t.id)), eq(donations.status, 'pending')))
          .orderBy(asc(donations.createdAt));
  const latestReservation = new Map(reservations.map((r) => [r.teamId, r.createdAt]));
  return {
    notDrawn: outside.filter((team) => team.confirmed).map((team) => ({ id: team.id, name: team.name })),
    withdrawnFromDraw,
    unpaid: reserving.map((team) => ({
      id: team.id,
      name: team.name,
      reservationExpiresAt: reservationExpiresAt({ createdAt: latestReservation.get(team.id) ?? clock.now }, clock).toISOString(),
    })),
  };
}

// ---- Public reads -------------------------------------------------------------------------

export const listTournamentsQuerySchema = z.object({
  status: z.enum(TOURNAMENT_STATUSES.filter((s) => s !== 'draft') as [TournamentStatus, ...TournamentStatus[]]).optional(),
});

/** Statuses of events still to come or in play; everything else non-draft is over. */
const AHEAD_STATUSES: readonly TournamentStatus[] = ['registration_open', 'registration_closed', 'live'];

/**
 * Non-draft tournaments, optionally filtered by status: events still ahead or in play
 * soonest first, then events that are over, most recent first.
 */
export async function listPublicTournaments(
  db: DbOrTx,
  filter: { status?: TournamentStatus | undefined },
  clock: ReservationClock,
): Promise<PublicTournament[]> {
  const rows = await db
    .select({ tournament: tournaments, beneficiary: charities })
    .from(tournaments)
    .innerJoin(charities, eq(charities.id, tournaments.beneficiaryId))
    .where(filter.status === undefined ? ne(tournaments.status, 'draft') : eq(tournaments.status, filter.status))
    .orderBy(asc(tournaments.startsAt), asc(tournaments.id));
  const ahead = rows.filter((r) => AHEAD_STATUSES.includes(r.tournament.status));
  const over = rows.filter((r) => !AHEAD_STATUSES.includes(r.tournament.status)).reverse();
  const ordered = [...ahead, ...over];
  const ids = ordered.map((r) => r.tournament.id);
  const counts = await teamCounts(db, ids, clock);
  return ordered.map((r) => toPublicTournament(r.tournament, r.beneficiary, counts.get(r.tournament.id) ?? 0));
}

async function teamCounts(db: DbOrTx, tournamentIds: string[], clock: ReservationClock): Promise<Map<string, number>> {
  if (tournamentIds.length === 0) return new Map();
  const rows = await db
    .select({ tournamentId: teams.tournamentId, n: count() })
    .from(teams)
    .where(and(inArray(teams.tournamentId, tournamentIds), inArray(teams.status, [...COUNTED_TEAM_STATUSES]), placeHoldingTeam(clock)))
    .groupBy(teams.tournamentId);
  return new Map(rows.map((r) => [r.tournamentId, r.n]));
}

/** A tournament by slug that the public may see: anything but a draft. */
export async function findPublicTournament(db: DbOrTx, slug: string): Promise<{ tournament: Tournament; beneficiary: Charity } | null> {
  const [row] = await db
    .select({ tournament: tournaments, beneficiary: charities })
    .from(tournaments)
    .innerJoin(charities, eq(charities.id, tournaments.beneficiaryId))
    .where(and(eq(tournaments.slug, slug), ne(tournaments.status, 'draft')));
  return row ?? null;
}

type Charity = typeof charities.$inferSelect;

/**
 * The public detail. `teams` is every team holding a place plus every team the persisted
 * draw still refers to (a team withdrawn after going live stays in its pool, its matches
 * and its opponents' results, with `status: 'withdrawn'`); `teamCount` is the counted set.
 */
export async function tournamentDetail(db: DbOrTx, slug: string, clock: ReservationClock): Promise<PublicTournamentDetail | null> {
  const found = await findPublicTournament(db, slug);
  if (found === null) return null;
  const { tournament, beneficiary } = found;

  const countedRows = await db.select().from(teams).where(countedTeamsFilter(tournament.id, clock)).orderBy(asc(teams.seed), asc(teams.createdAt));
  const stage = await loadPoolStage(db, tournament.id);
  const countedIds = new Set(countedRows.map((t) => t.id));
  const drawnOnly = [
    ...new Set([...stage.poolTeams.map((pt) => pt.teamId), ...stage.matches.flatMap((m) => [m.teamAId, m.teamBId, m.winnerTeamId])]),
  ].filter((id): id is string => id !== null && !countedIds.has(id));
  const drawnRows = drawnOnly.length === 0 ? [] : await db.select().from(teams).where(inArray(teams.id, drawnOnly)).orderBy(asc(teams.createdAt));
  const teamRows = [...countedRows, ...drawnRows];
  const teamIds = teamRows.map((t) => t.id);
  const memberRows =
    teamIds.length === 0
      ? []
      : await db
          .select({ member: teamMembers, user: users })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(inArray(teamMembers.teamId, teamIds));

  const standings = publicStandings(stage, tournament.drawConfig);
  const publicMatches: PublicMatch[] = stage.matches.map((m) => toPublicMatch(m, stage.sets));
  const publicPools = stage.pools.map((pool) =>
    toPublicPool(pool, stage.poolTeams, publicMatches, standings.find((s) => s.poolId === pool.id)?.standings ?? []),
  );
  const bracketMatches = publicMatches.filter((m) => m.bracketPosition !== null);
  const bracket =
    bracketMatches.length === 0
      ? null
      : {
          size: bracketMatches.length + 1,
          rounds: Math.max(...bracketMatches.map((m) => m.round)),
          matches: bracketMatches.sort((x, y) => (x.bracketPosition ?? 0) - (y.bracketPosition ?? 0)),
        };
  const sponsorRows = await db.select().from(sponsors).where(eq(sponsors.tournamentId, tournament.id)).orderBy(asc(sponsors.createdAt));

  return {
    ...toPublicTournament(tournament, beneficiary, countedRows.length),
    teams: teamRows.map((team) => toPublicTeam(team, memberRows.filter((m) => m.member.teamId === team.id))),
    pools: publicPools,
    bracket,
    sponsors: sponsorRows.map(toPublicSponsor),
  };
}
