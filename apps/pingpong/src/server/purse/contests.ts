import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { ContestState } from '@purse/types';
import { newId } from '@repo/ids';

import type { DbOrTx } from '../../db/client';
import { players, seasonEntries, seasons, type Season, type SeasonEntry } from '../../db/schema';
import { PURSE_ASSET, SEASON_ENTRY_POINTS, SEASON_PRIZE_STRUCTURE } from '../../domain/ladder';
import type { ContestTransitionName, ParsedContest, ParsedPreview } from '../../purse';
import { failure } from '../http/errors';
import { idempotencyKey, type PurseDeps } from './deps';

/**
 * The contest side of the boundary: one Purse contest per season, created and opened
 * when the season is opened and locked and started when play begins. Every step is
 * idempotent under a key derived from the season's opaque `purse_external_id`, so a
 * mirror that failed halfway is simply run again. Purse's answer is recorded in
 * `seasons.purse_contest_state`; it is a mirror, never authoritative.
 *
 *   enrolling  ─►  contest open            (entries accepted through the embed's entry flow)
 *   playing    ─►  locked, then in_progress (confirmed results push running scores)
 *   closing    ─►  awaiting_settlement      (final scores pushed, preview frozen; close.ts)
 *   closed     ─►  settled
 */
export function seasonSubject(season: Pick<Season, 'id'>) {
  return { type: 'season' as const, id: season.id };
}

async function recordContestState(db: DbOrTx, seasonId: string, state: ContestState, contestId: string, now: Date): Promise<void> {
  await db.update(seasons).set({ purseContestId: contestId, purseContestState: state, updatedAt: now }).where(eq(seasons.id, seasonId));
}

/** Create the season's contest if it has none, and read it if it has. */
export async function ensureContest(deps: PurseDeps, season: Season, input: { requestId: string; now: Date }): Promise<ParsedContest> {
  const subject = seasonSubject(season);
  if (season.purseContestId !== null) {
    const read = await deps.purse.getContest(season.purseContestId, { requestId: input.requestId, subject });
    await recordContestState(deps.db, season.id, read.data.state, read.data.id, input.now);
    return read.data;
  }
  const created = await deps.purse.createContest(
    {
      externalId: season.purseExternalId,
      // Purse's kinds are tournament, head_to_head and pool; a ladder season is a pool of
      // players ranked against each other (docs/decisions.md, what the second tenant exposed).
      kind: 'pool',
      title: season.title,
      asset: PURSE_ASSET,
      entryAmount: SEASON_ENTRY_POINTS,
      prizeStructure: SEASON_PRIZE_STRUCTURE,
      settlementPolicy: 'operator_close',
    },
    { requestId: input.requestId, idempotencyKey: idempotencyKey(season.purseExternalId, 'create'), subject },
  );
  await recordContestState(deps.db, season.id, created.data.state, created.data.id, input.now);
  return created.data;
}

async function step(deps: PurseDeps, season: Season, contest: ParsedContest, to: ContestTransitionName, input: { requestId: string; now: Date }): Promise<ParsedContest> {
  const moved = await deps.purse.transitionContest(contest.id, to, { requestId: input.requestId, idempotencyKey: idempotencyKey(season.purseExternalId, to), subject: seasonSubject(season) });
  await recordContestState(deps.db, season.id, moved.data.state, moved.data.id, input.now);
  return moved.data;
}

/** Bring the contest to the state the season's status implies, one idempotent step at a time. */
export async function mirrorContestState(deps: PurseDeps, season: Season, contest: ParsedContest, input: { requestId: string; now: Date }): Promise<ParsedContest> {
  let current = contest;
  if (current.state === 'draft') current = await step(deps, season, current, 'open', input);
  if (season.status === 'playing' || season.status === 'closing' || season.status === 'closed') {
    if (current.state === 'open') current = await step(deps, season, current, 'lock', input);
    if (current.state === 'locked') current = await step(deps, season, current, 'start', input);
  }
  return current;
}

/** The contest, created, opened and moved as far as the season's status says. */
export async function ensureMirroredContest(deps: PurseDeps, season: Season, input: { requestId: string; now: Date }): Promise<ParsedContest> {
  const contest = await ensureContest(deps, season, input);
  return mirrorContestState(deps, season, contest, input);
}

/**
 * Who Purse holds as entrants, recorded as the ladder: one `season_entries` row per
 * entered participant whose Purse user is a linked player, new entrants joining at the
 * bottom in the order Purse lists them. Never assumed from a browser event: the entry
 * happened in Purse's frame, so Purse is asked (the preview lists entries in every state).
 */
export async function readBackEntries(deps: PurseDeps, season: Season, input: { requestId: string; now: Date }): Promise<{ contest: ParsedContest; entries: SeasonEntry[]; added: number }> {
  const contest = await ensureMirroredContest(deps, season, input);
  const preview = await deps.purse.previewContest(contest.id, { requestId: input.requestId, subject: seasonSubject(season) });
  const added = await recordEntries(deps.db, season, preview.data.entries, input.now);
  const entries = await ladderOf(deps.db, season.id);
  return { contest, entries, added };
}

export async function recordEntries(db: DbOrTx, season: Pick<Season, 'id'>, entries: ParsedPreview['entries'], now: Date): Promise<number> {
  const entered = entries.filter((e) => e.participantState === 'entered');
  if (entered.length === 0) return 0;
  return db.transaction(async (tx) => {
    // The season row lock orders concurrent read-backs, so two cannot both hand out the same bottom rank.
    await tx.execute(sql`select 1 from seasons where id = ${season.id} for update`);
    const linked = await tx
      .select({ id: players.id, purseUserId: players.purseUserId })
      .from(players)
      .where(inArray(players.purseUserId, entered.map((e) => e.userId)));
    const playerByPurse = new Map(linked.map((p) => [p.purseUserId, p.id]));
    const existing = await tx.select({ playerId: seasonEntries.playerId, rank: seasonEntries.rank }).from(seasonEntries).where(eq(seasonEntries.seasonId, season.id));
    const held = new Set(existing.map((e) => e.playerId));
    let rank = existing.reduce((max, e) => Math.max(max, e.rank), 0);
    let added = 0;
    for (const entry of entered) {
      const playerId = playerByPurse.get(entry.userId);
      if (playerId === undefined || held.has(playerId)) continue;
      rank += 1;
      await tx.insert(seasonEntries).values({ id: newId('sne'), seasonId: season.id, playerId, rank, purseParticipantId: entry.participantId, enteredAt: now, createdAt: now, updatedAt: now });
      held.add(playerId);
      added += 1;
    }
    return added;
  });
}

export async function ladderOf(db: DbOrTx, seasonId: string): Promise<SeasonEntry[]> {
  return db.select().from(seasonEntries).where(eq(seasonEntries.seasonId, seasonId)).orderBy(asc(seasonEntries.rank));
}

export async function loadSeason(db: DbOrTx, seasonId: string): Promise<Season> {
  const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
  if (season === undefined) throw failure.notFound('season_not_found', 'No such season.');
  return season;
}

/** Lock the season row for the rest of the transaction; every season write starts here. */
export async function lockSeason(tx: DbOrTx, seasonId: string): Promise<Season> {
  const [season] = await tx.select().from(seasons).where(eq(seasons.id, seasonId)).for('update');
  if (season === undefined) throw failure.notFound('season_not_found', 'No such season.');
  return season;
}
