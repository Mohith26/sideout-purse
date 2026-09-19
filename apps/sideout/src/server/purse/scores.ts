import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import type { ParsedContest as ContestResource, ParsedScores as ScoresResource } from '../../purse/schemas';

import { matchConsensus, matches, purseEntries, teamMembers, tournaments, users, type Match, type MatchConsensus, type Tournament } from '../../db/schema';
import { toPurseAttestation } from '../../domain/attestation';
import { assertMayPushToPurse, assertMayRetryPurse, CONSENSUS_AUDIT, PursePushRefused } from '../../domain/consensus';
import { finalStandings, FinalStandingsError, type FinalPlacement } from '../../domain/final-standings';
import { finalScores, runningScore } from '../../domain/purse-score';
import { describeFailure, isPurseFailure, PurseApiError, type ScoreSubmissionInput } from '../../purse';
import type { Actor } from '../actor';
import { writeAudit } from '../audit';
import { listLiveSubmissions, moveConsensus } from '../consensus';
import type { DbOrTx } from '../db';
import { failure } from '../http/errors';
import { liveTransaction } from '../live/outbox';
import { loadPoolStage, publicStandings } from '../standings';
import { contestSubject, ensurePurseContest, mirrorContestState, readBackEntries } from './contests';
import { idempotencyKey, type PurseDeps } from './deps';

/**
 * Scores across the boundary (spec 5.2 rules 4 and 5; docs/decisions.md, phase 7).
 *
 * `pushMatchScores`: an agreed match's players get their running score (their team's
 * wins so far) submitted to the contest in one batch under the consensus's idempotency
 * key, `attemptFinished: false`. Purse accepting it is `pushed_to_purse`; Purse answering
 * the same request again from its idempotency store, with the same score ids, is
 * `confirmed`: the replay is the read-back that proves the batch is durably held, and it
 * creates nothing new (spec section 2, rule 4). A failure at either step leaves the
 * consensus where it was with the failure recorded, for the organizer's retry, which runs
 * the same steps under the same key.
 *
 * `pushFinalStandings`: once every match is complete, every entrant's final score,
 * derived from the tournament's final standings, `attemptFinished: true`, under one key
 * per tournament. Purse then holds every expected result and moves to
 * `awaiting_settlement` itself; `finish` covers an entrant Sideout could not place (a
 * player entered in Purse who never played), who is scored `null` and places last.
 *
 * Only players Purse holds as entrants are scored: Purse would refuse a batch naming
 * anyone else, and a player who holds no stake has nothing for Purse to settle.
 *
 * Each team's device signature travels with its players' running scores (spec section 12,
 * item 1): a team whose standing submission carries the agreed scoreline's hash and a
 * verified attestation has that attestation attached, attributed to the signer's linked
 * Purse user, and Purse verifies it again against its own copy of the key. A team that
 * submitted unsigned, or whose reading the organizer overrode, sends none.
 */

export type PushOutcome = { consensus: MatchConsensus; purse: 'confirmed' | 'pushed_to_purse' | 'agreed'; error?: ReturnType<typeof describeFailure> };

type Loaded = { match: Match; tournament: Tournament; consensus: MatchConsensus };

async function loadForPush(db: DbOrTx, matchId: string): Promise<Loaded> {
  const [row] = await db
    .select({ match: matches, tournament: tournaments, consensus: matchConsensus })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(eq(matchConsensus.matchId, matchId));
  if (row === undefined) throw failure.notFound('consensus_not_found', 'This match has no consensus to push.');
  return row;
}

/** Entered players of the given teams, with the Purse user id each is scored under. */
async function enteredPlayers(db: DbOrTx, tournamentId: string, teamIds: readonly string[]): Promise<Array<{ userId: string; purseUserId: string; teamId: string }>> {
  if (teamIds.length === 0) return [];
  const rows = await db
    .select({ userId: users.id, purseUserId: users.purseUserId, teamId: teamMembers.teamId, entryState: purseEntries.state })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .innerJoin(purseEntries, and(eq(purseEntries.tournamentId, tournamentId), eq(purseEntries.userId, users.id)))
    .where(and(inArray(teamMembers.teamId, [...teamIds]), eq(purseEntries.state, 'entered')));
  return rows.flatMap((r) => (r.purseUserId === null ? [] : [{ userId: r.userId, purseUserId: r.purseUserId, teamId: r.teamId }]));
}

/** Complete matches each team has won so far in the tournament (byes are not wins). */
async function winsByTeam(db: DbOrTx, tournamentId: string, teamIds: readonly string[]): Promise<Map<string, number>> {
  const won = await db
    .select({ winnerTeamId: matches.winnerTeamId })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.status, ['final', 'forfeited']), inArray(matches.winnerTeamId, [...teamIds])));
  const out = new Map(teamIds.map((id) => [id, 0]));
  for (const m of won) if (m.winnerTeamId !== null) out.set(m.winnerTeamId, (out.get(m.winnerTeamId) ?? 0) + 1);
  return out;
}

/** The contest scores go to: the mirrored id when Purse was last seen accepting scores, otherwise the contest brought up to date. */
async function contestForScores(deps: PurseDeps, tournament: Tournament, input: { requestId: string; now: Date }): Promise<Pick<ContestResource, 'id' | 'state'>> {
  if (tournament.purseContestId !== null && (tournament.purseContestState === 'in_progress' || tournament.purseContestState === 'awaiting_settlement')) {
    return { id: tournament.purseContestId, state: tournament.purseContestState };
  }
  const contest = await ensurePurseContest(deps, tournament, input);
  return mirrorContestState(deps, tournament, contest, input);
}

function sameBatch(first: ScoresResource, replay: ScoresResource): boolean {
  const ids = (r: ScoresResource) => r.scores.map((s) => s.id).sort().join(',');
  return ids(first) === ids(replay);
}

/**
 * Each team's verified attestation of the agreed scoreline, attributed to the signer's
 * linked Purse user: the standing submission per team whose hash is the agreed hash and
 * whose row carries a signature. A signer who never linked a Purse account has nothing
 * Purse could check the signature against, so that team sends none.
 */
async function agreedAttestations(db: DbOrTx, loaded: Loaded): Promise<Map<string, ScoreSubmissionInput['attestation']>> {
  const out = new Map<string, ScoreSubmissionInput['attestation']>();
  if (loaded.consensus.agreedHash === null) return out;
  const live = await listLiveSubmissions(db, loaded.match.id);
  const signers = live.flatMap((s) => (s.attestation === null ? [] : [s.attestation.userId]));
  const linked = signers.length === 0 ? [] : await db.select({ id: users.id, purseUserId: users.purseUserId }).from(users).where(inArray(users.id, signers));
  const purseUserOf = new Map(linked.flatMap((u) => (u.purseUserId === null ? [] : [[u.id, u.purseUserId] as const])));
  for (const submission of live) {
    if (submission.submittedForTeamId === null || submission.attestation === null || submission.hash !== loaded.consensus.agreedHash) continue;
    const purseUserId = purseUserOf.get(submission.attestation.userId);
    if (purseUserId === undefined) continue;
    out.set(submission.submittedForTeamId, toPurseAttestation(submission.attestation, purseUserId));
  }
  return out;
}

/**
 * The batch for one agreed match, or `null` when no player of either team holds a Purse
 * entry (nothing for Purse to settle on this match).
 */
export async function matchScoreBatch(db: DbOrTx, loaded: Loaded): Promise<ScoreSubmissionInput[] | null> {
  const teamIds = [loaded.match.teamAId, loaded.match.teamBId].filter((id): id is string => id !== null);
  const players = await enteredPlayers(db, loaded.tournament.id, teamIds);
  if (players.length === 0) return null;
  const wins = await winsByTeam(db, loaded.tournament.id, teamIds);
  const attestations = await agreedAttestations(db, loaded);
  return players.map((p) => ({
    userId: p.purseUserId,
    score: runningScore(wins.get(p.teamId) ?? 0),
    attemptFinished: false,
    sourceRef: loaded.match.id,
    attestation: attestations.get(p.teamId) ?? null,
  }));
}

/** Mint a fresh key for a consensus whose batch Purse refuses to match to the old one; audited, and only ever from an organizer's retry. */
async function rotateKey(db: DbOrTx, loaded: Loaded, actor: Actor, now: Date, cause: PurseApiError): Promise<string> {
  const fresh = randomUUID();
  await db.update(matchConsensus).set({ idempotencyKey: fresh, updatedAt: now }).where(eq(matchConsensus.id, loaded.consensus.id));
  await writeAudit(db, {
    actor,
    action: 'consensus.key_rotated',
    subjectType: 'match',
    subjectId: loaded.match.id,
    detail: { consensusId: loaded.consensus.id, previousKey: loaded.consensus.idempotencyKey, idempotencyKey: fresh, purse: cause.toJSON() },
    at: now,
  });
  return fresh;
}

async function recordPushFailure(db: DbOrTx, loaded: Loaded, actor: Actor, error: unknown, now: Date, step: 'push' | 'confirm'): Promise<MatchConsensus> {
  const described = describeFailure(error, now);
  const [updated] = await db.update(matchConsensus).set({ lastPushError: described, updatedAt: now }).where(eq(matchConsensus.id, loaded.consensus.id)).returning();
  await writeAudit(db, {
    actor,
    action: CONSENSUS_AUDIT.pushFailed,
    subjectType: 'match',
    subjectId: loaded.match.id,
    detail: { consensusId: loaded.consensus.id, state: loaded.consensus.state, step, idempotencyKey: loaded.consensus.idempotencyKey, error: described },
    at: now,
  });
  return updated ?? loaded.consensus;
}

/**
 * Push an agreed match (or retry a push or its confirmation) and report where the
 * consensus ended up. Never throws for a Purse failure; the state and the failure are in
 * the result, and the consensus row.
 */
export async function pushMatchScores(deps: PurseDeps, input: { matchId: string; actor: Actor; requestId: string; now: Date; retry?: boolean }): Promise<PushOutcome> {
  const { now, actor, requestId } = input;
  let loaded = await loadForPush(deps.db, input.matchId);
  const gate = { matchId: loaded.match.id, state: loaded.consensus.state, idempotencyKey: loaded.consensus.idempotencyKey };
  try {
    if (input.retry === true) assertMayRetryPurse(gate);
    else assertMayPushToPurse(gate);
  } catch (error) {
    if (error instanceof PursePushRefused) throw failure.invalidState(error.code, error.message, { state: loaded.consensus.state });
    throw error;
  }
  const subject = { type: 'match' as const, id: loaded.match.id };

  // The contest, without a round trip when the mirror already shows it accepting scores.
  let contest: Pick<ContestResource, 'id' | 'state'>;
  try {
    contest = await contestForScores(deps, loaded.tournament, { requestId, now });
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    const consensus = await recordPushFailure(deps.db, loaded, actor, error, now, 'push');
    return { consensus, purse: loaded.consensus.state === 'pushed_to_purse' ? 'pushed_to_purse' : 'agreed', error: describeFailure(error, now) };
  }

  const batch = await matchScoreBatch(deps.db, loaded);
  if (batch === null) {
    // Nobody in this match holds a Purse entry: there is nothing to push and nothing to confirm.
    const consensus = await liveTransaction(deps.db, async (tx) => {
      let current = loaded.consensus;
      if (current.state === 'agreed') current = await moveConsensus(tx, { consensus: current, tournamentId: loaded.tournament.id }, 'pushed_to_purse', actor, now, { pushedAt: now, lastPushError: null }, { nothingToPush: true, contestId: contest.id });
      if (current.state === 'pushed_to_purse') current = await moveConsensus(tx, { consensus: current, tournamentId: loaded.tournament.id }, 'confirmed', actor, now, { confirmedAt: now }, { nothingToPush: true, contestId: contest.id });
      return current;
    });
    return { consensus, purse: 'confirmed' };
  }

  // Step 1: the push. Under the consensus key, so a retry after a lost answer is the same
  // request, and a retry from `pushed_to_purse` is Purse's replay of the batch it holds.
  let first: ScoresResource;
  let key = gate.idempotencyKey ?? '';
  try {
    first = (await deps.purse.submitScores(contest.id, batch, { requestId, idempotencyKey: key, subject })).data;
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    if (input.retry === true && error instanceof PurseApiError && error.code === 'idempotency_key_reused' && loaded.consensus.state === 'agreed') {
      // The batch is not what the key was first used for (a player has since left the
      // contest, say), and Purse holds the earlier request under it. The one audited
      // exception to "one key": the organizer's retry rotates it and sends once more.
      key = await rotateKey(deps.db, loaded, actor, now, error);
      loaded = await loadForPush(deps.db, input.matchId);
      try {
        first = (await deps.purse.submitScores(contest.id, batch, { requestId, idempotencyKey: key, subject })).data;
      } catch (again) {
        if (!isPurseFailure(again)) throw again;
        const consensus = await recordPushFailure(deps.db, loaded, actor, again, now, 'push');
        return { consensus, purse: 'agreed', error: describeFailure(again, now) };
      }
    } else {
      const consensus = await recordPushFailure(deps.db, loaded, actor, error, now, 'push');
      return { consensus, purse: loaded.consensus.state === 'pushed_to_purse' ? 'pushed_to_purse' : 'agreed', error: describeFailure(error, now) };
    }
  }
  if (loaded.consensus.state === 'agreed') {
    const moved = await moveConsensus(deps.db, { consensus: loaded.consensus, tournamentId: loaded.tournament.id }, 'pushed_to_purse', actor, now, { pushedAt: now, lastPushError: null }, {
      contestId: contest.id,
      idempotencyKey: key,
      scores: first.scores.map((s) => ({ id: s.id, userId: s.userId, score: s.score })),
      replayed: false,
      contestState: first.contest.state,
    });
    loaded = { ...loaded, consensus: moved };
  }

  // Step 2: the confirmation. The same request again; Purse must answer from its store.
  let replay: { data: ScoresResource; replayed: boolean };
  try {
    replay = await deps.purse.submitScores(contest.id, batch, { requestId, idempotencyKey: key, subject });
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    const consensus = await recordPushFailure(deps.db, loaded, actor, error, now, 'confirm');
    return { consensus, purse: 'pushed_to_purse', error: describeFailure(error, now) };
  }
  if (!replay.replayed || !sameBatch(first, replay.data)) {
    const consensus = await recordPushFailure(deps.db, loaded, actor, new Error(replay.replayed ? 'the replay named different score rows' : 'Purse performed the request again instead of replaying it'), now, 'confirm');
    return { consensus, purse: 'pushed_to_purse', error: describeFailure(new Error('confirmation did not match the push'), now) };
  }
  const confirmed = await moveConsensus(deps.db, { consensus: loaded.consensus, tournamentId: loaded.tournament.id }, 'confirmed', actor, now, { confirmedAt: now, lastPushError: null }, {
    contestId: contest.id,
    idempotencyKey: key,
    scores: replay.data.scores.map((s) => ({ id: s.id, userId: s.userId, score: s.score })),
    replayed: true,
  });
  await deps.db.update(tournaments).set({ purseContestState: replay.data.contest.state, updatedAt: now }).where(eq(tournaments.id, loaded.tournament.id));
  return { consensus: confirmed, purse: 'confirmed' };
}

// ---- Final standings ------------------------------------------------------------------------

export type FinalStandingsPush = {
  contest: ContestResource;
  standings: FinalPlacement[];
  /** Every entrant scored, Purse user id to score (`null` for one Sideout could not place). */
  scored: Array<{ purseUserId: string; userId: string | null; teamId: string | null; score: number | null }>;
  replayed: boolean;
};

/** The tournament's final standings from its rows, or a named refusal when they are not final yet. */
export async function computeFinalStandings(db: DbOrTx, tournament: Tournament): Promise<FinalPlacement[]> {
  const stage = await loadPoolStage(db, tournament.id);
  const drawnTeamIds = [...new Set([...stage.poolTeams.map((pt) => pt.teamId), ...stage.matches.flatMap((m) => [m.teamAId, m.teamBId]).filter((id): id is string => id !== null)])];
  try {
    return finalStandings({
      format: tournament.format,
      teamIds: drawnTeamIds,
      matches: stage.matches.map((m) => ({ id: m.id, round: m.round, bracketPosition: m.bracketPosition, status: m.status, teamAId: m.teamAId, teamBId: m.teamBId, winnerTeamId: m.winnerTeamId })),
      pools: publicStandings(stage, tournament.drawConfig).map((pool) => ({ standings: pool.standings })),
    });
  } catch (error) {
    if (error instanceof FinalStandingsError) throw failure.invalidState(error.code, error.message);
    throw error;
  }
}

/**
 * Push every entrant's final score once, under the tournament's `final-standings` key,
 * and move the contest to `awaiting_settlement` if an unplaceable entrant kept it from
 * getting there on its own. Idempotent: a second call replays both requests.
 */
export async function pushFinalStandings(deps: PurseDeps, tournament: Tournament, input: { requestId: string; now: Date; actor: Actor }): Promise<FinalStandingsPush> {
  const { requestId, now } = input;
  const standings = await computeFinalStandings(deps.db, tournament);
  const scoreByTeam = finalScores(standings);

  const readBack = await readBackEntries(deps, tournament, { requestId, now });
  let contest = await mirrorContestState(deps, tournament, readBack.contest, { requestId, now });
  const entered = readBack.entries.filter((e) => e.participantState === 'entered');
  if (entered.length === 0) throw failure.invalidState('no_entrants', 'Purse holds no entrants for this tournament; there is nothing to settle.');

  const placedTeamIds = standings.map((p) => p.teamId);
  const members = await deps.db
    .select({ userId: users.id, purseUserId: users.purseUserId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(placedTeamIds.length === 0 ? eq(teamMembers.teamId, '') : inArray(teamMembers.teamId, placedTeamIds));
  const teamByPurseUser = new Map(members.flatMap((m) => (m.purseUserId === null ? [] : [[m.purseUserId, { userId: m.userId, teamId: m.teamId }] as const])));

  const scored = entered.map((entry) => {
    const placed = teamByPurseUser.get(entry.userId);
    const score = placed === undefined ? null : (scoreByTeam.get(placed.teamId) ?? null);
    return { purseUserId: entry.userId, userId: placed?.userId ?? null, teamId: placed?.teamId ?? null, score };
  });
  const batch: ScoreSubmissionInput[] = scored.map((s) => ({ userId: s.purseUserId, score: s.score, attemptFinished: true, sourceRef: tournament.id }));
  const subject = contestSubject(tournament);

  if (contest.state === 'in_progress' || contest.state === 'awaiting_settlement') {
    const pushed = await deps.purse.submitScores(contest.id, batch, { requestId, idempotencyKey: idempotencyKey(tournament.purseExternalId, 'final-standings'), subject });
    contest = pushed.data.contest;
    if (contest.state === 'in_progress') {
      const finished = await deps.purse.transitionContest(contest.id, 'finish', { requestId, idempotencyKey: idempotencyKey(tournament.purseExternalId, 'finish'), subject }, 'every Sideout match is complete');
      contest = finished.data;
    }
    await deps.db.transaction(async (tx) => {
      await tx.update(tournaments).set({ purseContestState: contest.state, updatedAt: now }).where(eq(tournaments.id, tournament.id));
      if (!pushed.replayed) {
        await writeAudit(tx, {
          actor: input.actor,
          action: 'tournament.purse_final_standings_pushed',
          subjectType: 'tournament',
          subjectId: tournament.id,
          detail: { contestId: contest.id, standings, scored, contestState: contest.state },
          at: now,
        });
      }
    });
    return { contest, standings, scored, replayed: pushed.replayed };
  }
  return { contest, standings, scored, replayed: true };
}

