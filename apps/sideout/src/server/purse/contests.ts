import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ContestState } from '@purse/types';

import type { ParsedContest as ContestResource, ParsedPreview as PreviewResource } from '../../purse/schemas';
import { newId } from '@repo/ids';

import { purseEntries, sponsors, teamMembers, teams, tournaments, users, type PurseEntry, type Tournament } from '../../db/schema';
import { PURSE_ASSET, PURSE_ENTRY_POINTS, prizeStructureFor } from '../../domain/purse-score';
import { describeFailure, isPurseFailure, PurseApiError, type ContestTransitionName } from '../../purse';
import { SYSTEM_ACTOR, type Actor } from '../actor';
import { writeAudit } from '../audit';
import type { DbOrTx } from '../db';
import { confirmedTeamsFilter } from '../field';
import { failure } from '../http/errors';
import { idempotencyKey, type PurseDeps } from './deps';

/**
 * The contest side of the boundary: one Purse contest per tournament, created when
 * registration opens and mirrored as the tournament moves (docs/decisions.md, phase 7).
 * Every step is idempotent under a key derived from the tournament's opaque
 * `purse_external_id`, so a mirror that failed halfway (Purse down, the process gone) is
 * simply run again. Purse's answer is recorded in `purse_contest_state`; it is a mirror,
 * never authoritative, and a webhook may update it too.
 *
 *   registration_open, registration_closed  ─►  contest open   (entries accepted)
 *   live                                    ─►  locked, then in_progress
 *   awaiting_settlement                     ─►  final standings pushed (scores.ts), then
 *                                               awaiting_settlement (Purse gets there on
 *                                               its own once every entrant has a finished
 *                                               score; `finish` covers an entrant that
 *                                               never will)
 *   cancelled                               ─►  voided (every stake refunded)
 *   settled                                 ─►  closed by the organizer (close.ts)
 *
 * Purse has no unlock, so the contest is locked when the tournament goes live rather
 * than when registration closes: registration can reopen, and a team finishing its
 * Purse entry after the organizer closed registration is exactly what the second
 * registration step needs.
 */

export function contestSubject(tournament: Pick<Tournament, 'id'>) {
  return { type: 'tournament' as const, id: tournament.id };
}

async function recordContestState(db: DbOrTx, tournamentId: string, state: ContestState, contestId: string, now: Date): Promise<void> {
  await db.update(tournaments).set({ purseContestId: contestId, purseContestState: state, updatedAt: now }).where(eq(tournaments.id, tournamentId));
}

/** Create the tournament's contest if it has none, and read it if it has. */
export async function ensurePurseContest(deps: PurseDeps, tournament: Tournament, input: { requestId: string; now: Date }): Promise<ContestResource> {
  const subject = contestSubject(tournament);
  if (tournament.purseContestId !== null) {
    const read = await deps.purse.getContest(tournament.purseContestId, { requestId: input.requestId, subject });
    await recordContestState(deps.db, tournament.id, read.data.state, read.data.id, input.now);
    return read.data;
  }
  const sponsorRows = await deps.db.select().from(sponsors).where(eq(sponsors.tournamentId, tournament.id)).orderBy(asc(sponsors.createdAt));
  const created = await deps.purse.createContest(
    {
      externalId: tournament.purseExternalId,
      kind: 'tournament',
      title: tournament.name,
      asset: PURSE_ASSET,
      entryAmount: PURSE_ENTRY_POINTS,
      maxParticipants: tournament.maxTeams * 2,
      prizeStructure: prizeStructureFor(sponsorRows),
      settlementPolicy: 'operator_close',
    },
    { requestId: input.requestId, idempotencyKey: idempotencyKey(tournament.purseExternalId, 'create'), subject },
  );
  await deps.db.transaction(async (tx) => {
    await recordContestState(tx, tournament.id, created.data.state, created.data.id, input.now);
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'tournament.purse_contest_created',
      subjectType: 'tournament',
      subjectId: tournament.id,
      detail: { contestId: created.data.id, replayed: created.replayed, asset: created.data.asset, entryAmount: created.data.entryAmount, prizeStructure: created.data.prizeStructure },
      at: input.now,
    });
  });
  return created.data;
}

const STEP_KEYS: Record<ContestTransitionName, string> = { open: 'open', lock: 'lock', start: 'start', finish: 'finish' };

async function step(deps: PurseDeps, tournament: Tournament, contest: ContestResource, to: ContestTransitionName, input: { requestId: string; now: Date }): Promise<ContestResource> {
  const moved = await deps.purse.transitionContest(contest.id, to, { requestId: input.requestId, idempotencyKey: idempotencyKey(tournament.purseExternalId, STEP_KEYS[to]), subject: contestSubject(tournament) });
  await recordContestState(deps.db, tournament.id, moved.data.state, moved.data.id, input.now);
  return moved.data;
}

/**
 * Bring the contest to the state the tournament's status implies, one idempotent step
 * at a time. The final standings push and the close are not here: the first is
 * `scores.ts` (it needs the standings), the second is the organizer's explicit act.
 */
export async function mirrorContestState(deps: PurseDeps, tournament: Tournament, contest: ContestResource, input: { requestId: string; now: Date }): Promise<ContestResource> {
  let current = contest;
  const wants = tournament.status;
  if (wants === 'registration_open' || wants === 'registration_closed' || wants === 'live' || wants === 'awaiting_settlement' || wants === 'settled') {
    if (current.state === 'draft') current = await step(deps, tournament, current, 'open', input);
  }
  if (wants === 'live' || wants === 'awaiting_settlement' || wants === 'settled') {
    if (current.state === 'open') current = await step(deps, tournament, current, 'lock', input);
    if (current.state === 'locked') current = await step(deps, tournament, current, 'start', input);
  }
  if (wants === 'cancelled') {
    if (current.state === 'open' || current.state === 'locked' || current.state === 'in_progress' || current.state === 'awaiting_settlement') {
      const voided = await deps.purse.voidContest(current.id, { requestId: input.requestId, idempotencyKey: idempotencyKey(tournament.purseExternalId, 'void'), subject: contestSubject(tournament) }, 'tournament cancelled');
      current = voided.data.contest;
      await deps.db.transaction(async (tx) => {
        await recordContestState(tx, tournament.id, current.state, current.id, input.now);
        await writeAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'tournament.purse_contest_voided',
          subjectType: 'tournament',
          subjectId: tournament.id,
          detail: { contestId: current.id, refunds: voided.data.refundJournalEntryIds.length, replayed: voided.replayed },
          at: input.now,
        });
      });
    }
  }
  return current;
}

export type MirrorOutcome = { status: 'mirrored'; contestId: string; contestState: ContestState } | { status: 'failed'; error: ReturnType<typeof describeFailure> } | { status: 'skipped'; reason: string };

/**
 * After a tournament transition commits: make Purse agree. Never throws for a Purse
 * failure; the failure is audited and returned, and the next transition, the entry step,
 * or the close preview runs the same idempotent mirror again.
 */
export async function mirrorTournament(deps: PurseDeps, input: { tournamentId: string; requestId: string; now: Date; actor: Actor }): Promise<MirrorOutcome> {
  const [tournament] = await deps.db.select().from(tournaments).where(eq(tournaments.id, input.tournamentId));
  if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
  if (tournament.status === 'draft') return { status: 'skipped', reason: 'a draft has no contest yet' };
  if (tournament.status === 'cancelled' && tournament.purseContestId === null) return { status: 'skipped', reason: 'the tournament was cancelled before it had a contest' };
  try {
    const contest = await ensurePurseContest(deps, tournament, input);
    const mirrored = await mirrorContestState(deps, tournament, contest, input);
    return { status: 'mirrored', contestId: mirrored.id, contestState: mirrored.state };
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    const described = describeFailure(error, input.now);
    deps.log.warn('purse mirror failed', { tournamentId: tournament.id, status: tournament.status, ...described });
    await writeAudit(deps.db, {
      actor: input.actor,
      action: 'tournament.purse_mirror_failed',
      subjectType: 'tournament',
      subjectId: tournament.id,
      detail: { status: tournament.status, error: described },
      at: input.now,
    });
    return { status: 'failed', error: described };
  }
}

// ---- Entries: who Purse holds as entrants -------------------------------------------------

/** Record what the contest says about its entrants: one `purse_entries` row per participant, matched to a local player where the Purse user is linked. */
export async function recordEntries(db: DbOrTx, tournament: Pick<Tournament, 'id'>, entries: PreviewResource['entries'], source: 'read_back' | 'webhook', now: Date): Promise<PurseEntry[]> {
  if (entries.length === 0) return [];
  const linked = await db
    .select({ id: users.id, purseUserId: users.purseUserId })
    .from(users)
    .where(inArray(users.purseUserId, entries.map((e) => e.userId)));
  const localByPurse = new Map(linked.map((u) => [u.purseUserId, u.id]));
  const rows = await db
    .insert(purseEntries)
    .values(
      entries.map((entry) => ({
        id: newId('pen'),
        tournamentId: tournament.id,
        purseUserId: entry.userId,
        userId: localByPurse.get(entry.userId) ?? null,
        purseParticipantId: entry.participantId,
        state: entry.participantState === 'withdrawn' ? ('withdrawn' as const) : ('entered' as const),
        source,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [purseEntries.tournamentId, purseEntries.purseUserId],
      set: {
        userId: sql`excluded.user_id`,
        purseParticipantId: sql`excluded.purse_participant_id`,
        state: sql`excluded.state`,
        source: sql`excluded.source`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning();
  return rows;
}

/** Read the contest's entrants back from Purse (the preview lists them in every state) and record them. */
export async function readBackEntries(deps: PurseDeps, tournament: Tournament, input: { requestId: string; now: Date }): Promise<{ contest: ContestResource; entries: PreviewResource['entries'] }> {
  const contest = await ensurePurseContest(deps, tournament, input);
  const preview = await deps.purse.previewContest(contest.id, { requestId: input.requestId, subject: contestSubject(tournament) });
  await recordEntries(deps.db, tournament, preview.data.entries, 'read_back', input.now);
  return { contest, entries: preview.data.entries };
}

export type EntryReconciliation = {
  contestId: string | null;
  contestState: string | null;
  /** Every player of a confirmed team, with whether Purse holds their entry. */
  expected: Array<{ userId: string; displayName: string; teamId: string; teamName: string; linked: boolean; entered: boolean }>;
  /** Expected players Purse does not hold. */
  missing: Array<{ userId: string; displayName: string; teamId: string; teamName: string; linked: boolean }>;
  /** Purse entrants who are not a player of a confirmed team. */
  extra: Array<{ purseUserId: string; userId: string | null; displayName: string | null }>;
};

/** Sideout's roster against Purse's entrants, from what has been recorded (call `readBackEntries` first for a fresh view). */
export async function reconcileEntries(db: DbOrTx, tournament: Tournament): Promise<EntryReconciliation> {
  const roster = await db
    .select({ userId: users.id, displayName: users.displayName, purseUserId: users.purseUserId, teamId: teams.id, teamName: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(confirmedTeamsFilter(tournament.id))
    .orderBy(asc(teams.createdAt), asc(teamMembers.createdAt));
  const held = await db
    .select({ entry: purseEntries, displayName: users.displayName })
    .from(purseEntries)
    .leftJoin(users, eq(users.id, purseEntries.userId))
    .where(and(eq(purseEntries.tournamentId, tournament.id), eq(purseEntries.state, 'entered')));
  const heldByPurseUser = new Map(held.map((h) => [h.entry.purseUserId, h]));
  const expected = roster.map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
    teamId: member.teamId,
    teamName: member.teamName,
    linked: member.purseUserId !== null,
    entered: member.purseUserId !== null && heldByPurseUser.has(member.purseUserId),
  }));
  const expectedPurseIds = new Set(roster.map((m) => m.purseUserId).filter((id): id is string => id !== null));
  return {
    contestId: tournament.purseContestId,
    contestState: tournament.purseContestState,
    expected,
    missing: expected.filter((m) => !m.entered).map(({ entered: _entered, ...rest }) => rest),
    extra: held.filter((h) => !expectedPurseIds.has(h.entry.purseUserId)).map((h) => ({ purseUserId: h.entry.purseUserId, userId: h.entry.userId, displayName: h.displayName })),
  };
}

/** Purse's `not_eligible` and friends as they reach a caller through a Sideout route, unchanged in type and code. */
export function purseFailureToApi(error: unknown): never {
  if (error instanceof PurseApiError) {
    const type = error.type;
    if (type === 'not_eligible' || type === 'insufficient_funds') {
      throw failure.invalidState(error.code, error.message, { purse: error.toJSON() }).withStatus(error.status);
    }
    throw failure.internal('purse_refused', `Purse refused the request: ${error.message}`, { purse: error.toJSON() }).withStatus(502);
  }
  if (isPurseFailure(error)) throw failure.internal('purse_unreachable', error.message).withStatus(502);
  throw error;
}
