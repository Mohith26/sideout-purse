import { eq } from 'drizzle-orm';

import { seasons, type Player, type Season } from '../../db/schema';
import { previewMatches, type FrozenClosePreview, type SeasonSettlement } from '../../domain/close-preview';
import { PurseApiError, type ParsedPreview, type ParsedSettlement } from '../../purse';
import { failure } from '../http/errors';
import { lockSeason, seasonSubject } from './contests';
import { idempotencyKey, type PurseDeps } from './deps';
import { pushFinalScores } from './scores';

/**
 * Closing a season through Purse's frozen preview (spec 4.7, 4.10), as a two-step confirm:
 *
 * 1. `previewClose`: refused while a match is still open; otherwise the season becomes
 *    `closing` (nothing more is played, so the ranks are final), the final scores are
 *    pushed (idempotent; they supersede every running score), Purse's preview is fetched, its
 *    entries are checked against the ladder, and the whole thing is frozen on the season
 *    with its `payoutHash`.
 * 2. `closeSeason`: takes the hash the commissioner saw, refuses any other, posts the
 *    close to Purse (which recomputes and refuses a stale hash itself), and on success
 *    marks the season `closed` with the settlement kept verbatim.
 */
export type ClosePreview = { season: Season; preview: ParsedPreview; standings: FrozenClosePreview['standings'] };

export async function previewClose(deps: PurseDeps, input: { seasonId: string; actor: Player; requestId: string; now: Date }): Promise<ClosePreview> {
  const { requestId, now } = input;
  const season = await deps.db.transaction(async (tx) => {
    const locked = await lockSeason(tx, input.seasonId);
    if (locked.commissionerId !== input.actor.id) throw failure.permission('commissioner_only', 'Only the commissioner closes the season.');
    if (locked.status !== 'playing' && locked.status !== 'closing') throw failure.invalidState('season_not_closable', `A season is closed from playing; this one is ${locked.status}.`);
    const open = await tx.query.ladderMatches.findMany({ where: (m, { and, eq: equal, inArray }) => and(equal(m.seasonId, locked.id), inArray(m.status, ['challenged', 'reported'])) });
    if (open.length > 0) throw failure.invalidState('matches_open', `${open.length} match(es) are still open; play or decline them first.`, { matchIds: open.map((m) => m.id) });
    if (locked.status === 'closing') return locked;
    const [updated] = await tx.update(seasons).set({ status: 'closing', updatedAt: now }).where(eq(seasons.id, locked.id)).returning();
    if (updated === undefined) throw new Error('season vanished mid-preview');
    return updated;
  });

  const pushed = await pushFinalScores(deps, season, { requestId, now });
  const preview = (await deps.purse.previewContest(pushed.contest.id, { requestId, subject: seasonSubject(season) })).data;

  const expected = new Map(pushed.scored.map((s) => [s.purseUserId, s.score]));
  const diverged = preview.entries.filter((e) => e.participantState === 'entered').filter((e) => !expected.has(e.userId) || expected.get(e.userId) !== e.score || !e.attemptFinished);
  if (diverged.length > 0) {
    throw failure.conflict('purse_scores_diverged', `Purse's scores differ from the ladder for ${diverged.length} entrant(s).`, { diverged: diverged.map((e) => ({ purseUserId: e.userId, purseScore: e.score, expected: expected.get(e.userId) ?? null })) });
  }
  const frozen: FrozenClosePreview = {
    version: 1,
    contestId: preview.contestId,
    payoutHash: preview.payoutHash,
    escrowTotal: preview.escrowTotal,
    entries: preview.entries,
    payouts: preview.payouts,
    standings: pushed.scored.map(({ playerId, purseUserId, rank, wins, losses, score }) => ({ playerId, purseUserId, rank, wins, losses, score })),
    contestState: preview.state,
    previewedAt: now.toISOString(),
    previewedByPlayerId: input.actor.id,
  };
  const [stored] = await deps.db.update(seasons).set({ purseClosePreview: frozen, purseContestState: preview.state, updatedAt: now }).where(eq(seasons.id, season.id)).returning();
  if (stored === undefined) throw new Error('season vanished mid-preview');
  return { season: stored, preview, standings: frozen.standings };
}

export type CloseResult = { season: Season; settlement: ParsedSettlement; replayed: boolean };

/** Step 2. Only the frozen preview's hash is accepted, and only Purse's recomputation decides whether it still holds. */
export async function closeSeason(deps: PurseDeps, input: { seasonId: string; payoutHash: string; actor: Player; requestId: string; now: Date }): Promise<CloseResult> {
  const { requestId, now } = input;
  const season = await deps.db.transaction(async (tx) => lockSeason(tx, input.seasonId));
  if (season.commissionerId !== input.actor.id) throw failure.permission('commissioner_only', 'Only the commissioner closes the season.');
  const frozen: FrozenClosePreview | null = season.purseClosePreview;
  const held: string | null = frozen?.payoutHash ?? null;
  // A close already made, confirmed again with the same hash (a lost answer, a second click) replays; anything else needs a preview first.
  if (season.status !== 'closing' && !(season.status === 'closed' && held === input.payoutHash)) {
    throw failure.invalidState('season_not_closing', 'Fetch the close preview first.');
  }
  if (!previewMatches(frozen, input.payoutHash)) {
    throw failure.conflict('preview_hash_mismatch', held === null ? 'Fetch the close preview first; the close confirms the hash it showed.' : 'The hash does not match the frozen preview; fetch a new preview and confirm its hash.', { presented: input.payoutHash, frozen: held });
  }

  const subject = seasonSubject(season);
  let settlement: ParsedSettlement;
  let replayed: boolean;
  const current = (await deps.purse.getContest(frozen.contestId, { requestId, subject })).data;
  if (current.state === 'settled') {
    // Closed already (a lost answer, or from Purse's own console): read the settlement back; it must be the one previewed.
    const recorded = (await deps.purse.previewContest(frozen.contestId, { requestId, subject })).data;
    if (recorded.payoutHash !== input.payoutHash) {
      throw failure.conflict('preview_hash_mismatch', 'Purse settled this contest with a different payout set than the one previewed.', { presented: input.payoutHash, settled: recorded.payoutHash });
    }
    const results = (await deps.purse.getResults(frozen.contestId, { requestId, subject })).data;
    settlement = { contest: current, results: results.results, payoutHash: recorded.payoutHash, journalEntryId: null };
    replayed = true;
  } else {
    try {
      // Keyed by the frozen preview, not the hash alone: Purse stores a refusal under its key.
      const closed = await deps.purse.closeContest(frozen.contestId, input.payoutHash, { requestId, idempotencyKey: idempotencyKey(season.purseExternalId, 'close', frozen.payoutHash, String(Date.parse(frozen.previewedAt))), subject });
      settlement = closed.data;
      replayed = closed.replayed;
    } catch (error) {
      if (error instanceof PurseApiError && error.code === 'preview_hash_mismatch') {
        await deps.db.update(seasons).set({ purseClosePreview: null, updatedAt: now }).where(eq(seasons.id, season.id));
        throw failure.conflict('preview_hash_mismatch', 'The contest changed since the preview was frozen; Purse refused the hash. Fetch a new preview and confirm again.', { purse: error.toJSON() });
      }
      throw error;
    }
  }

  const kept: SeasonSettlement = {
    contestId: settlement.contest.id,
    payoutHash: settlement.payoutHash,
    journalEntryId: settlement.journalEntryId,
    settledAt: settlement.contest.settledAt,
    results: settlement.results.map((r) => ({ userId: r.userId, placement: r.placement, score: r.score, payoutAmount: r.payoutAmount })),
    replayed,
  };
  const updated = await deps.db.transaction(async (tx) => {
    const locked = await lockSeason(tx, season.id);
    const [after] = await tx
      .update(seasons)
      .set({ status: 'closed', closedAt: locked.closedAt ?? now, purseSettlement: kept, purseContestState: settlement.contest.state, updatedAt: now })
      .where(eq(seasons.id, season.id))
      .returning();
    if (after === undefined) throw new Error('season vanished mid-close');
    return after;
  });
  return { season: updated, settlement, replayed };
}
