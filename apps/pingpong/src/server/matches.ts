import { and, eq, inArray } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../db/client';
import { ladderMatches, seasonEntries, type LadderMatch, type Player } from '../db/schema';
import { applyResult, judgeChallenge, judgeScoreline, type LadderEntry } from '../domain/ladder';
import { failure } from './http/errors';
import { ladderOf, lockSeason } from './purse/contests';

/**
 * Challenges and results. Every write takes the season's row lock first, so the ladder
 * the rules are judged against is the ladder the rows are written to. A result is
 * reported by one side and confirmed by the other; only a confirmed result moves the
 * ladder, and it is at confirmation that the match gets the idempotency key its scores
 * are pushed to Purse under (`purse/scores.ts`, after the commit).
 */

async function loadMatch(db: Parameters<typeof lockSeason>[0], matchId: string): Promise<LadderMatch> {
  const [match] = await db.select().from(ladderMatches).where(eq(ladderMatches.id, matchId));
  if (match === undefined) throw failure.notFound('match_not_found', 'No such match.');
  return match;
}

function asLadder(entries: Array<{ playerId: string; rank: number; wins: number; losses: number }>): LadderEntry[] {
  return entries.map((e) => ({ playerId: e.playerId, rank: e.rank, wins: e.wins, losses: e.losses }));
}

export async function challenge(db: Db, input: { seasonId: string; challenger: Player; defenderId: string; now: Date }): Promise<LadderMatch> {
  return db.transaction(async (tx) => {
    const season = await lockSeason(tx, input.seasonId);
    if (season.status !== 'playing') throw failure.invalidState('season_not_playing', `Challenges are issued while the season is playing; it is ${season.status}.`);
    const ladder = asLadder(await ladderOf(tx, season.id));
    const open = await tx
      .select({ challengerId: ladderMatches.challengerId, defenderId: ladderMatches.defenderId })
      .from(ladderMatches)
      .where(and(eq(ladderMatches.seasonId, season.id), inArray(ladderMatches.status, ['challenged', 'reported'])));
    const judged = judgeChallenge(ladder, input.challenger.id, input.defenderId, open);
    if (!judged.ok) throw failure.invalidState(`challenge_${judged.reason}`, judged.message);
    const [match] = await tx
      .insert(ladderMatches)
      .values({ id: newId('lmt'), seasonId: season.id, challengerId: input.challenger.id, defenderId: input.defenderId, status: 'challenged', createdAt: input.now, updatedAt: input.now })
      .returning();
    if (match === undefined) throw new Error('match insert returned no row');
    return match;
  });
}

export async function declineChallenge(db: Db, input: { matchId: string; actor: Player; now: Date }): Promise<LadderMatch> {
  return db.transaction(async (tx) => {
    const found = await loadMatch(tx, input.matchId);
    await lockSeason(tx, found.seasonId);
    const match = await loadMatch(tx, input.matchId);
    if (match.defenderId !== input.actor.id) throw failure.permission('defender_only', 'Only the challenged player can decline.');
    if (match.status !== 'challenged') throw failure.invalidState('match_not_open', `The match is ${match.status}.`);
    const [updated] = await tx.update(ladderMatches).set({ status: 'declined', updatedAt: input.now }).where(eq(ladderMatches.id, match.id)).returning();
    if (updated === undefined) throw new Error('match vanished');
    return updated;
  });
}

/** Either player enters the scoreline; the other must confirm it. Re-reporting replaces an unconfirmed scoreline. */
export async function reportResult(db: Db, input: { matchId: string; actor: Player; challengerScore: number; defenderScore: number; now: Date }): Promise<LadderMatch> {
  const judged = judgeScoreline({ challenger: input.challengerScore, defender: input.defenderScore });
  if (!judged.ok) throw failure.invalidRequest('scoreline_invalid', judged.message);
  return db.transaction(async (tx) => {
    const found = await loadMatch(tx, input.matchId);
    const season = await lockSeason(tx, found.seasonId);
    if (season.status !== 'playing') throw failure.invalidState('season_not_playing', `Results are reported while the season is playing; it is ${season.status}.`);
    const match = await loadMatch(tx, input.matchId);
    if (match.challengerId !== input.actor.id && match.defenderId !== input.actor.id) throw failure.permission('participant_only', 'Only the two players report this match.');
    if (match.status !== 'challenged' && match.status !== 'reported') throw failure.invalidState('match_not_open', `The match is ${match.status}.`);
    const [updated] = await tx
      .update(ladderMatches)
      .set({ status: 'reported', challengerScore: input.challengerScore, defenderScore: input.defenderScore, reportedById: input.actor.id, reportedAt: input.now, updatedAt: input.now })
      .where(eq(ladderMatches.id, match.id))
      .returning();
    if (updated === undefined) throw new Error('match vanished');
    return updated;
  });
}

export type ConfirmedResult = { match: LadderMatch; moved: boolean; ladder: LadderEntry[] };

/** The other player confirms: the result is final, the ladder moves, and the match is keyed for its Purse push. */
export async function confirmResult(db: Db, input: { matchId: string; actor: Player; now: Date }): Promise<ConfirmedResult> {
  return db.transaction(async (tx) => {
    const found = await loadMatch(tx, input.matchId);
    const season = await lockSeason(tx, found.seasonId);
    if (season.status !== 'playing') throw failure.invalidState('season_not_playing', `Results are confirmed while the season is playing; it is ${season.status}.`);
    const match = await loadMatch(tx, input.matchId);
    if (match.status !== 'reported' || match.challengerScore === null || match.defenderScore === null) throw failure.invalidState('match_not_reported', 'Nothing has been reported to confirm.');
    if (match.challengerId !== input.actor.id && match.defenderId !== input.actor.id) throw failure.permission('participant_only', 'Only the two players confirm this match.');
    if (match.reportedById === input.actor.id) throw failure.invalidState('confirm_other_side', 'The other player confirms what you reported.');
    const judged = judgeScoreline({ challenger: match.challengerScore, defender: match.defenderScore });
    if (!judged.ok) throw failure.invalidState('scoreline_invalid', judged.message);
    const before = asLadder(await ladderOf(tx, season.id));
    const applied = applyResult(before, { challengerId: match.challengerId, defenderId: match.defenderId, winner: judged.winner });
    for (const entry of applied.ladder) {
      await tx
        .update(seasonEntries)
        .set({ rank: entry.rank, wins: entry.wins, losses: entry.losses, updatedAt: input.now })
        .where(and(eq(seasonEntries.seasonId, season.id), eq(seasonEntries.playerId, entry.playerId)));
    }
    const [updated] = await tx
      .update(ladderMatches)
      .set({ status: 'confirmed', confirmedById: input.actor.id, confirmedAt: input.now, winnerId: applied.winnerId, ladderMoved: applied.moved, purseIdempotencyKey: newId('lmt'), updatedAt: input.now })
      .where(eq(ladderMatches.id, match.id))
      .returning();
    if (updated === undefined) throw new Error('match vanished');
    return { match: updated, moved: applied.moved, ladder: applied.ladder };
  });
}

/** Reject what the other side reported: back to `challenged`, scoreline cleared, to be reported again. */
export async function rejectResult(db: Db, input: { matchId: string; actor: Player; now: Date }): Promise<LadderMatch> {
  return db.transaction(async (tx) => {
    const found = await loadMatch(tx, input.matchId);
    await lockSeason(tx, found.seasonId);
    const match = await loadMatch(tx, input.matchId);
    if (match.status !== 'reported') throw failure.invalidState('match_not_reported', 'Nothing has been reported to reject.');
    if (match.challengerId !== input.actor.id && match.defenderId !== input.actor.id) throw failure.permission('participant_only', 'Only the two players reject this match.');
    if (match.reportedById === input.actor.id) throw failure.invalidState('reject_other_side', 'Report a corrected scoreline instead.');
    const [updated] = await tx
      .update(ladderMatches)
      .set({ status: 'challenged', challengerScore: null, defenderScore: null, reportedById: null, reportedAt: null, updatedAt: input.now })
      .where(eq(ladderMatches.id, match.id))
      .returning();
    if (updated === undefined) throw new Error('match vanished');
    return updated;
  });
}
