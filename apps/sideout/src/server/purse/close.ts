import { asc, eq, inArray } from 'drizzle-orm';
import type { ParsedPreview as PreviewResource, ParsedSettlement as SettlementResource } from '../../purse/schemas';

import { matchConsensus, matches, pools, teamMembers, teams, tournaments, users, type ConsensusState, type MatchStatus, type Tournament, type User } from '../../db/schema';
import { previewMatches, type FrozenClosePreview } from '../../domain/close-preview';
import { CLOSE_BLOCKING_STATES } from '../../domain/consensus';
import type { FinalPlacement } from '../../domain/final-standings';
import { PurseApiError } from '../../purse';
import { actorFor, SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { DbOrTx } from '../db';
import { failure } from '../http/errors';
import { transitionTournament } from '../tournaments';
import { contestSubject } from './contests';
import { idempotencyKey, type PurseDeps } from './deps';
import { pushFinalStandings } from './scores';

/**
 * Closing a tournament through Purse's frozen preview (spec 4.7, 4.10; 5.2 rule 6), as a
 * two-step confirm:
 *
 * 1. `previewClose`: refused while any match blocks it, naming each blocker; otherwise
 *    the final standings are pushed (idempotent), Purse's preview is fetched, its entries
 *    are checked against the standings, and the whole thing is frozen on the tournament
 *    with its `payoutHash`.
 * 2. `closeTournament`: takes the hash the organizer saw, refuses any other, posts the
 *    close to Purse (which recomputes and refuses a stale hash itself), and on success
 *    moves the tournament to `settled` as the system, the one actor allowed to.
 *
 * `contest.settled` arriving by webhook moves the tournament the same way, idempotently,
 * for a close whose answer was lost.
 */

export type CloseBlocker = {
  matchId: string;
  label: string;
  matchStatus: MatchStatus;
  consensusState: ConsensusState | null;
  teamA: string | null;
  teamB: string | null;
  reason: string;
  lastPushError: { type: string; code: string; message: string; at: string } | null;
};

function explain(status: MatchStatus, state: ConsensusState | null, error: CloseBlocker['lastPushError']): string {
  if (status === 'disputed' || state === 'disputed') return 'The two teams submitted different scorelines; resolve the dispute.';
  if (status === 'scheduled') return 'The match has not been played.';
  if (status === 'in_progress') return 'The match is in progress.';
  if (status === 'awaiting_scores') return state === 'awaiting_second' ? 'One team has submitted; the other has not.' : 'The match is waiting on both teams’ scorelines.';
  if (state === null) return 'The match is final but has no consensus record; it was never scored through the score sheet.';
  if (state === 'agreed') return error === null ? 'Agreed, not yet pushed to Purse; retry the push.' : `Agreed, but the push to Purse failed (${error.code}); retry it.`;
  if (state === 'pushed_to_purse') return error === null ? 'Purse accepted the scores but has not confirmed them; retry the confirmation.' : `Purse accepted the scores; the confirmation failed (${error.code}); retry it.`;
  return `The match is ${status.replace('_', ' ')}.`;
}

/** Every match that stands between the tournament and its close, with why. */
export async function closeBlockers(db: DbOrTx, tournamentId: string): Promise<CloseBlocker[]> {
  const rows = await db
    .select({ match: matches, consensus: matchConsensus, poolLabel: pools.label, teamA: teams.name })
    .from(matches)
    .leftJoin(matchConsensus, eq(matchConsensus.matchId, matches.id))
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .leftJoin(teams, eq(teams.id, matches.teamAId))
    .where(eq(matches.tournamentId, tournamentId))
    .orderBy(asc(matches.round), asc(matches.bracketPosition), asc(matches.id));
  const teamBIds = rows.map((r) => r.match.teamBId).filter((id): id is string => id !== null);
  const teamBRows = teamBIds.length === 0 ? [] : await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamBIds));
  const teamBName = new Map(teamBRows.map((t) => [t.id, t.name]));
  const blockers: CloseBlocker[] = [];
  for (const { match, consensus, poolLabel, teamA } of rows) {
    const state = consensus?.state ?? null;
    const blocked =
      match.status === 'disputed' ||
      (match.status === 'final' && (state === null || CLOSE_BLOCKING_STATES.has(state))) ||
      (match.status !== 'final' && match.status !== 'forfeited' && match.status !== 'bye');
    if (!blocked) continue;
    blockers.push({
      matchId: match.id,
      label: match.poolId !== null ? `${poolLabel ?? 'Pool'} · round ${match.round}` : `Bracket · round ${match.round}, position ${match.bracketPosition ?? '?'}`,
      matchStatus: match.status,
      consensusState: state,
      teamA,
      teamB: match.teamBId === null ? null : (teamBName.get(match.teamBId) ?? null),
      reason: explain(match.status, state, consensus?.lastPushError ?? null),
      lastPushError: consensus?.lastPushError ?? null,
    });
  }
  return blockers;
}

export type ClosePreview = {
  tournamentId: string;
  status: Tournament['status'];
  contestId: string;
  contestState: string;
  payoutHash: string;
  escrowTotal: string;
  standings: Array<FinalPlacement & { teamName: string; players: Array<{ userId: string; displayName: string; purseUserId: string | null }> }>;
  entries: PreviewResource['entries'];
  payouts: PreviewResource['payouts'];
  previewedAt: string;
  blockers: CloseBlocker[];
};

async function loadTournament(db: DbOrTx, tournamentId: string): Promise<Tournament> {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
  if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
  return tournament;
}

function assertClosable(tournament: Tournament, blockers: CloseBlocker[]): void {
  if (tournament.status !== 'awaiting_settlement') {
    throw failure.invalidState('tournament_not_awaiting_settlement', `A tournament is closed from awaiting settlement; ${tournament.name} is ${tournament.status.replace('_', ' ')}.`, {
      status: tournament.status,
    });
  }
  if (blockers.length > 0) {
    throw failure.invalidState('close_blocked', `${blockers.length} match(es) block the close: ${blockers.map((b) => `${b.label} (${b.reason})`).join('; ')}`, { blockers });
  }
}

async function decorateStandings(db: DbOrTx, standings: FinalPlacement[]): Promise<ClosePreview['standings']> {
  const ids = standings.map((s) => s.teamId);
  if (ids.length === 0) return [];
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, ids));
  const nameOf = new Map(teamRows.map((t) => [t.id, t.name]));
  const memberRows = await db
    .select({ teamId: teamMembers.teamId, userId: users.id, displayName: users.displayName, purseUserId: users.purseUserId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(inArray(teamMembers.teamId, ids))
    .orderBy(asc(teamMembers.createdAt));
  const players = new Map<string, Array<{ userId: string; displayName: string; purseUserId: string | null }>>();
  for (const row of memberRows) players.set(row.teamId, [...(players.get(row.teamId) ?? []), { userId: row.userId, displayName: row.displayName, purseUserId: row.purseUserId }]);
  return standings.map((s) => ({ ...s, teamName: nameOf.get(s.teamId) ?? s.teamId, players: players.get(s.teamId) ?? [] }));
}

/**
 * Step 1. The preview is frozen only when Purse's entries agree with Sideout's final
 * standings: every entrant Sideout placed carries the placed score and a finished
 * attempt, and nothing else is scored. Otherwise the organizer sees what diverged.
 */
export async function previewClose(deps: PurseDeps, input: { tournamentId: string; organizer: User; requestId: string; now: Date }): Promise<ClosePreview> {
  const { requestId, now } = input;
  const tournament = await loadTournament(deps.db, input.tournamentId);
  const blockers = await closeBlockers(deps.db, tournament.id);
  assertClosable(tournament, blockers);

  const pushed = await pushFinalStandings(deps, tournament, { requestId, now, actor: actorFor(input.organizer) });
  const preview = (await deps.purse.previewContest(pushed.contest.id, { requestId, subject: contestSubject(tournament) })).data;

  const expected = new Map(pushed.scored.map((s) => [s.purseUserId, s.score]));
  const diverged = preview.entries
    .filter((e) => e.participantState === 'entered')
    .filter((e) => !expected.has(e.userId) || expected.get(e.userId) !== e.score || !e.attemptFinished)
    .map((e) => ({ purseUserId: e.userId, purseScore: e.score, attemptFinished: e.attemptFinished, expected: expected.get(e.userId) ?? null }));
  if (diverged.length > 0) {
    throw failure.conflict('purse_scores_diverged', `Purse's scores differ from Sideout's final standings for ${diverged.length} entrant(s); the final standings were not fully pushed.`, { diverged });
  }

  const frozen: FrozenClosePreview = {
    version: 1,
    contestId: preview.contestId,
    payoutHash: preview.payoutHash,
    escrowTotal: preview.escrowTotal,
    entries: preview.entries,
    payouts: preview.payouts,
    standings: pushed.standings,
    contestState: preview.state,
    previewedAt: now.toISOString(),
    previewedByUserId: input.organizer.id,
  };
  await deps.db.transaction(async (tx) => {
    await tx.update(tournaments).set({ purseClosePreview: frozen, purseContestState: preview.state, updatedAt: now }).where(eq(tournaments.id, tournament.id));
    await writeAudit(tx, {
      actor: actorFor(input.organizer),
      action: 'tournament.close_previewed',
      subjectType: 'tournament',
      subjectId: tournament.id,
      detail: { contestId: preview.contestId, payoutHash: preview.payoutHash, escrowTotal: preview.escrowTotal, payouts: preview.payouts, contestState: preview.state },
      at: now,
    });
  });
  return {
    tournamentId: tournament.id,
    status: tournament.status,
    contestId: preview.contestId,
    contestState: preview.state,
    payoutHash: preview.payoutHash,
    escrowTotal: preview.escrowTotal,
    standings: await decorateStandings(deps.db, pushed.standings),
    entries: preview.entries,
    payouts: preview.payouts,
    previewedAt: frozen.previewedAt,
    blockers: [],
  };
}

export type CloseResult = { tournament: Tournament; settlement: SettlementResource; replayed: boolean };

/** Step 2. Only the frozen preview's hash is accepted, and only Purse's recomputation decides whether it still holds. */
export async function closeTournament(deps: PurseDeps, input: { tournamentId: string; payoutHash: string; organizer: User; requestId: string; now: Date; reservationTtlMs: number }): Promise<CloseResult> {
  const { requestId, now } = input;
  const tournament = await loadTournament(deps.db, input.tournamentId);
  const frozen = tournament.purseClosePreview;
  // A close already made, confirmed again with the same hash (a lost answer, a second
  // click): the same request to Purse, which replays it, and nothing moves.
  const replaying = tournament.status === 'settled' && previewMatches(frozen, input.payoutHash);
  if (!replaying) assertClosable(tournament, await closeBlockers(deps.db, tournament.id));
  if (!previewMatches(frozen, input.payoutHash)) {
    const held: string | null = tournament.purseClosePreview?.payoutHash ?? null;
    throw failure.conflict('preview_hash_mismatch', held === null ? 'Fetch the close preview first; the close confirms the hash it showed.' : 'The hash does not match the frozen preview; fetch a new preview and confirm its hash.', {
      presented: input.payoutHash,
      frozen: held,
    });
  }

  let settlement: SettlementResource;
  let replayed: boolean;
  const subject = contestSubject(tournament);
  // A contest Purse already settled (this close's answer was lost, or it was closed from
  // Purse's own console) is not closed again: its recorded settlement is read back, and
  // it must be the one the organizer confirmed.
  const current = (await deps.purse.getContest(frozen.contestId, { requestId, subject })).data;
  if (current.state === 'settled') {
    const recorded = (await deps.purse.previewContest(frozen.contestId, { requestId, subject })).data;
    if (recorded.payoutHash !== input.payoutHash) {
      throw failure.conflict('preview_hash_mismatch', 'Purse settled this contest with a different payout set than the one previewed.', { presented: input.payoutHash, settled: recorded.payoutHash });
    }
    const results = (await deps.purse.getResults(frozen.contestId, { requestId, subject })).data;
    settlement = { contest: current, results: results.results, payoutHash: recorded.payoutHash, journalEntryId: null };
    replayed = true;
  } else {
    try {
      // Keyed by the frozen preview, not the hash alone: Purse stores a refusal under its key
      // (a stale hash is the answer to that request), so a later preview that happens to
      // produce the same hash must be a new request.
      const closed = await deps.purse.closeContest(frozen.contestId, input.payoutHash, {
        requestId,
        idempotencyKey: closeKey(tournament, frozen),
        subject,
      });
      settlement = closed.data;
      replayed = closed.replayed;
    } catch (error) {
      if (error instanceof PurseApiError && error.code === 'preview_hash_mismatch') {
        await deps.db.transaction(async (tx) => {
          await tx.update(tournaments).set({ purseClosePreview: null, updatedAt: now }).where(eq(tournaments.id, tournament.id));
          await writeAudit(tx, {
            actor: actorFor(input.organizer),
            action: 'tournament.close_refused',
            subjectType: 'tournament',
            subjectId: tournament.id,
            detail: { contestId: frozen.contestId, payoutHash: input.payoutHash, purse: error.toJSON() },
            at: now,
          });
        });
        throw failure.conflict('preview_hash_mismatch', 'The contest changed since the preview was frozen; Purse refused the hash. Fetch a new preview and confirm again.', { purse: error.toJSON() });
      }
      throw error;
    }
  }

  const updated = await deps.db.transaction(async (tx) => {
    const [current] = await tx.select().from(tournaments).where(eq(tournaments.id, tournament.id)).for('update');
    if (current === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
    if (current.status === 'awaiting_settlement') {
      await transitionTournament(tx, { tournament: current, to: 'settled', actor: SYSTEM_ACTOR, clock: { now, reservationTtlMs: input.reservationTtlMs } });
    }
    await tx.update(tournaments).set({ purseContestState: settlement.contest.state, updatedAt: now }).where(eq(tournaments.id, tournament.id));
    await writeAudit(tx, {
      actor: actorFor(input.organizer),
      action: 'tournament.closed',
      subjectType: 'tournament',
      subjectId: tournament.id,
      detail: {
        contestId: settlement.contest.id,
        payoutHash: settlement.payoutHash,
        journalEntryId: settlement.journalEntryId,
        results: settlement.results.map((r) => ({ userId: r.userId, placement: r.placement, payoutAmount: r.payoutAmount })),
        replayed,
      },
      at: now,
    });
    const [after] = await tx.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    if (after === undefined) throw new Error('tournament vanished mid-close');
    return after;
  });
  return { tournament: updated, settlement, replayed };
}

/** The close's idempotency key: the frozen preview is the request, so the same preview confirmed again replays and a new preview is a new request. */
export function closeKey(tournament: Pick<Tournament, 'purseExternalId'>, frozen: Pick<FrozenClosePreview, 'payoutHash' | 'previewedAt'>): string {
  return idempotencyKey(tournament.purseExternalId, 'close', frozen.payoutHash, String(Date.parse(frozen.previewedAt)));
}

/** What the close page shows before any preview: the blockers, and the frozen preview if one is held. */
export async function closeStatus(db: DbOrTx, tournamentId: string): Promise<{ tournament: Tournament; blockers: CloseBlocker[]; frozen: FrozenClosePreview | null; standings: ClosePreview['standings'] | null }> {
  const tournament = await loadTournament(db, tournamentId);
  const blockers = await closeBlockers(db, tournament.id);
  const frozen = tournament.purseClosePreview;
  return { tournament, blockers, frozen, standings: frozen === null ? null : await decorateStandings(db, frozen.standings) };
}

