import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { newId } from '@repo/ids';
import { z } from 'zod';

import type { Db } from '../db/client';
import {
  charities,
  DIVISIONS,
  matches,
  sponsors,
  teamMembers,
  teams,
  TOURNAMENT_FORMATS,
  TOURNAMENT_STATUSES,
  tournaments,
  users,
  type Tournament,
  type TournamentStatus,
} from '../db/schema';
import { isMatchComplete, validateTournamentTransition } from '../domain/state';
import { mintPurseExternalId, type Actor } from './actor';
import { writeAudit } from './audit';
import type { DbOrTx } from './db';
import { failure } from './http/errors';
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
import { loadPoolStage, standingsForStage } from './standings';

/** Team statuses that count toward capacity and appear publicly. */
export const COUNTED_TEAM_STATUSES = ['registered', 'checked_in'] as const;

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
    format: z.enum(TOURNAMENT_FORMATS),
    division: z.enum(DIVISIONS),
    maxTeams: z.number().int().min(2).max(128),
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
    format: z.enum(TOURNAMENT_FORMATS).optional(),
    division: z.enum(DIVISIONS).optional(),
    maxTeams: z.number().int().min(2).max(128).optional(),
    entryDonationCents: centsSchema.optional(),
    fundraisingGoalCents: centsSchema.optional(),
    status: z.enum(TOURNAMENT_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });

export type UpdateTournamentInput = z.infer<typeof updateTournamentSchema>;

/** Fields that reshape the event; only a draft may change them. */
const DRAFT_ONLY_FIELDS = ['beneficiaryId', 'format', 'division', 'entryDonationCents'] as const;

export type UpdateResult = { tournament: Tournament; changedFields: string[]; transition: { from: TournamentStatus; to: TournamentStatus } | null };

export async function updateTournament(db: Db, id: string, input: UpdateTournamentInput, actor: Actor, now: Date): Promise<UpdateResult> {
  return db.transaction(async (tx) => {
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
        const registered = await countedTeams(tx, current.id);
        if (fields.maxTeams < registered) {
          throw failure.invalidState('max_teams_below_registered', `${registered} teams are already registered; maxTeams cannot be ${fields.maxTeams}.`);
        }
      }
      const startsAt = fields.startsAt ?? current.startsAt;
      const endsAt = fields.endsAt ?? current.endsAt;
      if (endsAt.getTime() < startsAt.getTime()) throw failure.invalidRequest('ends_before_start', 'endsAt must not be before startsAt.');

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
        detail: { fields: changedFields },
        at: now,
      });
    }

    let transition: UpdateResult['transition'] = null;
    if (nextStatus !== undefined) {
      transition = await transitionTournament(tx, { tournament: current, to: nextStatus, actor, now });
    }

    const [updated] = await tx.select().from(tournaments).where(eq(tournaments.id, id));
    if (updated === undefined) throw new Error('tournament vanished mid-transaction');
    return { tournament: updated, changedFields, transition };
  });
}

/**
 * The single place a tournament's status changes. Validates the transition matrix for
 * the actor, applies the guards that depend on rows (a draw before `live`, every match
 * complete before `awaiting_settlement`), and writes the audit row.
 */
export async function transitionTournament(
  tx: DbOrTx,
  input: { tournament: Tournament; to: TournamentStatus; actor: Actor; now: Date },
): Promise<{ from: TournamentStatus; to: TournamentStatus }> {
  const from = input.tournament.status;
  const verdict = validateTournamentTransition(from, input.to, input.actor.kind);
  if (!verdict.ok) {
    const type = verdict.code === 'actor_not_permitted' ? failure.permission : failure.invalidState;
    throw type(`transition_${verdict.code}`, verdict.message, { from, to: input.to });
  }

  if (input.to === 'live') {
    const [drawn] = await tx.select({ n: count() }).from(matches).where(eq(matches.tournamentId, input.tournament.id));
    if ((drawn?.n ?? 0) === 0) throw failure.invalidState('draw_required', 'Draw the tournament before going live.');
  }
  if (input.to === 'awaiting_settlement') {
    const open = await tx
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(eq(matches.tournamentId, input.tournament.id));
    if (open.length === 0) throw failure.invalidState('no_matches', 'There are no matches to settle.');
    const unresolved = open.filter((m) => !isMatchComplete(m.status));
    if (unresolved.length > 0) {
      throw failure.invalidState('matches_unresolved', `${unresolved.length} match(es) are not complete.`, {
        matches: unresolved.map((m) => ({ id: m.id, status: m.status })),
      });
    }
  }

  await tx.update(tournaments).set({ status: input.to, updatedAt: input.now }).where(eq(tournaments.id, input.tournament.id));
  await writeAudit(tx, {
    actor: input.actor,
    action: 'tournament.status_changed',
    subjectType: 'tournament',
    subjectId: input.tournament.id,
    detail: { from, to: input.to },
    at: input.now,
  });
  return { from, to: input.to };
}

export async function countedTeams(db: DbOrTx, tournamentId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(teams)
    .where(and(eq(teams.tournamentId, tournamentId), inArray(teams.status, [...COUNTED_TEAM_STATUSES])));
  return row?.n ?? 0;
}

// ---- Public reads -------------------------------------------------------------------------

export const listTournamentsQuerySchema = z.object({
  status: z.enum(TOURNAMENT_STATUSES.filter((s) => s !== 'draft') as [TournamentStatus, ...TournamentStatus[]]).optional(),
});

/** Non-draft tournaments, soonest first, optionally filtered by status. */
export async function listPublicTournaments(db: DbOrTx, filter: { status?: TournamentStatus | undefined }): Promise<PublicTournament[]> {
  const rows = await db
    .select({ tournament: tournaments, beneficiary: charities })
    .from(tournaments)
    .innerJoin(charities, eq(charities.id, tournaments.beneficiaryId))
    .where(filter.status === undefined ? ne(tournaments.status, 'draft') : eq(tournaments.status, filter.status))
    .orderBy(desc(tournaments.startsAt));
  const counts = await teamCounts(db, rows.map((r) => r.tournament.id));
  return rows.map((r) => toPublicTournament(r.tournament, r.beneficiary, counts.get(r.tournament.id) ?? 0));
}

async function teamCounts(db: DbOrTx, tournamentIds: string[]): Promise<Map<string, number>> {
  if (tournamentIds.length === 0) return new Map();
  const rows = await db
    .select({ tournamentId: teams.tournamentId, n: count() })
    .from(teams)
    .where(and(inArray(teams.tournamentId, tournamentIds), inArray(teams.status, [...COUNTED_TEAM_STATUSES])))
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

export async function tournamentDetail(db: DbOrTx, slug: string): Promise<PublicTournamentDetail | null> {
  const found = await findPublicTournament(db, slug);
  if (found === null) return null;
  const { tournament, beneficiary } = found;

  const teamRows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.tournamentId, tournament.id), inArray(teams.status, [...COUNTED_TEAM_STATUSES])))
    .orderBy(asc(teams.seed), asc(teams.createdAt));
  const teamIds = teamRows.map((t) => t.id);
  const memberRows =
    teamIds.length === 0
      ? []
      : await db
          .select({ member: teamMembers, user: users })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(inArray(teamMembers.teamId, teamIds));

  const stage = await loadPoolStage(db, tournament.id);
  const standings = standingsForStage(stage);
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
    ...toPublicTournament(tournament, beneficiary, teamRows.length),
    teams: teamRows.map((team) => toPublicTeam(team, memberRows.filter((m) => m.member.teamId === team.id))),
    pools: publicPools,
    bracket,
    sponsors: sponsorRows.map(toPublicSponsor),
  };
}
