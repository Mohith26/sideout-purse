import { and, eq, inArray } from 'drizzle-orm';

import { ladderMatches, players, seasonEntries, type Season } from '../../db/schema';
import { finalScores, runningScore } from '../../domain/ladder';
import { describeFailure, isPurseFailure, type ParsedContest, type ScoreSubmissionInput } from '../../purse';
import { failure } from '../http/errors';
import { ensureMirroredContest, ladderOf, loadSeason, seasonSubject } from './contests';
import { idempotencyKey, type PurseDeps } from './deps';

/**
 * Scores across the boundary. A confirmed result pushes both players' running scores
 * (their wins so far) in one batch under the key minted at confirmation, with
 * `attemptFinished: false`, so the next result simply supersedes it; the close pushes
 * every entrant's final score (rank turned upside down) with `attemptFinished: true`,
 * after which Purse holds every expected result and moves to `awaiting_settlement` on
 * its own. The final scores carry everything that settles, so a running score whose push
 * failed is a gap in Purse's mid-season view, never in the settlement; the match keeps the
 * failure for the retry (`POST /api/matches/:id/push`), which runs the same idempotent
 * push again. `pushMatchScores` never throws for a Purse failure.
 */

type Scored = { playerId: string; purseUserId: string };

/** Linked entrants among `playerIds`, with the Purse user id each is scored under. */
async function linkedEntrants(db: PurseDeps['db'], seasonId: string, playerIds: readonly string[]): Promise<Scored[]> {
  if (playerIds.length === 0) return [];
  const rows = await db
    .select({ playerId: players.id, purseUserId: players.purseUserId })
    .from(seasonEntries)
    .innerJoin(players, eq(players.id, seasonEntries.playerId))
    .where(and(eq(seasonEntries.seasonId, seasonId), inArray(seasonEntries.playerId, [...playerIds])));
  return rows.flatMap((r) => (r.purseUserId === null ? [] : [{ playerId: r.playerId, purseUserId: r.purseUserId }]));
}

export type PushOutcome = { status: 'pushed'; replayed: boolean } | { status: 'failed'; error: ReturnType<typeof describeFailure> } | { status: 'skipped'; reason: string };

/** Push a confirmed match's running scores; safe to call again for a match already pushed. */
export async function pushMatchScores(deps: PurseDeps, input: { matchId: string; requestId: string; now: Date }): Promise<PushOutcome> {
  const [match] = await deps.db.select().from(ladderMatches).where(eq(ladderMatches.id, input.matchId));
  if (match === undefined) throw failure.notFound('match_not_found', 'No such match.');
  if (match.status !== 'confirmed' || match.purseIdempotencyKey === null) return { status: 'skipped', reason: 'the match is not confirmed' };
  const season = await loadSeason(deps.db, match.seasonId);
  if (season.status !== 'playing') return { status: 'skipped', reason: `the season is ${season.status}; running scores are pushed while it plays` };
  const entrants = await linkedEntrants(deps.db, season.id, [match.challengerId, match.defenderId]);
  if (entrants.length === 0) return { status: 'skipped', reason: 'neither player holds a Purse entry' };
  const ladder = await ladderOf(deps.db, season.id);
  const batch: ScoreSubmissionInput[] = entrants.map((e) => ({
    userId: e.purseUserId,
    score: runningScore(ladder.find((row) => row.playerId === e.playerId)?.wins ?? 0),
    attemptFinished: false,
    sourceRef: match.id,
  }));
  try {
    const contest = await contestForScores(deps, season, input);
    const pushed = await deps.purse.submitScores(contest.id, batch, { requestId: input.requestId, idempotencyKey: match.purseIdempotencyKey, subject: { type: 'match', id: match.id } });
    await deps.db.update(ladderMatches).set({ pursePushedAt: input.now, pursePushError: null, updatedAt: input.now }).where(eq(ladderMatches.id, match.id));
    return { status: 'pushed', replayed: pushed.replayed };
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    const described = describeFailure(error, input.now);
    deps.log.warn('purse score push failed', { matchId: match.id, ...described });
    await deps.db.update(ladderMatches).set({ pursePushError: described, updatedAt: input.now }).where(eq(ladderMatches.id, match.id));
    return { status: 'failed', error: described };
  }
}

/** The contest scores go to: the mirrored id when Purse was last seen accepting scores, otherwise the contest brought up to date. */
async function contestForScores(deps: PurseDeps, season: Season, input: { requestId: string; now: Date }): Promise<Pick<ParsedContest, 'id' | 'state'>> {
  if (season.purseContestId !== null && (season.purseContestState === 'in_progress' || season.purseContestState === 'awaiting_settlement')) {
    return { id: season.purseContestId, state: season.purseContestState };
  }
  return ensureMirroredContest(deps, season, input);
}

export type FinalPush = { contest: ParsedContest; scored: Array<{ playerId: string; purseUserId: string; rank: number; wins: number; losses: number; score: number }> };

/**
 * Every entrant's final score, derived from the ladder, `attemptFinished: true`, under one
 * key per season. Only linked entrants are scored (Purse holds no one else); a rank set
 * that changed since a failed attempt cannot happen, because the season is `closing`.
 */
export async function pushFinalScores(deps: PurseDeps, season: Season, input: { requestId: string; now: Date }): Promise<FinalPush> {
  const ladder = await ladderOf(deps.db, season.id);
  const scores = finalScores(ladder.map((e) => ({ playerId: e.playerId, rank: e.rank, wins: e.wins, losses: e.losses })));
  const entrants = await linkedEntrants(deps.db, season.id, ladder.map((e) => e.playerId));
  const scored = entrants.map((e) => {
    const row = ladder.find((r) => r.playerId === e.playerId);
    if (row === undefined) throw new Error('entrant without a ladder row');
    return { ...e, rank: row.rank, wins: row.wins, losses: row.losses, score: scores.get(e.playerId) ?? 0 };
  });
  const contest = await ensureMirroredContest(deps, season, input);
  if (scored.length > 0) {
    await deps.purse.submitScores(
      contest.id,
      scored.map((s) => ({ userId: s.purseUserId, score: s.score, attemptFinished: true, sourceRef: `${season.id}:final` })),
      { requestId: input.requestId, idempotencyKey: idempotencyKey(season.purseExternalId, 'final'), subject: seasonSubject(season) },
    );
  }
  const after = await deps.purse.getContest(contest.id, { requestId: input.requestId, subject: seasonSubject(season) });
  return { contest: after.data, scored };
}
