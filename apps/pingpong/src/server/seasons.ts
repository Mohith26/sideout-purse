import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db, DbOrTx } from '../db/client';
import { ladderMatches, players, seasonEntries, seasons, type LadderMatch, type Player, type Season, type SeasonEntry } from '../db/schema';
import { CHALLENGE_REACH, SEASON_ENTRY_POINTS } from '../domain/ladder';
import { failure } from './http/errors';
import { publicPlayer, type PublicPlayer } from './players';
import { ensureMirroredContest, lockSeason } from './purse/contests';
import type { PurseDeps } from './purse/deps';

/**
 * Seasons: one at a time. Anyone signed in may open the next season when none is
 * running, and becomes its commissioner: the one who starts play (locking the Purse
 * contest, so the field is fixed) and, later, closes it through the frozen preview.
 */

export type LadderRow = { rank: number; player: PublicPlayer; wins: number; losses: number; you: boolean; challengeable: boolean };

export type MatchView = {
  id: string;
  status: LadderMatch['status'];
  challenger: PublicPlayer;
  defender: PublicPlayer;
  challengerScore: number | null;
  defenderScore: number | null;
  reportedBy: PublicPlayer | null;
  winner: PublicPlayer | null;
  ladderMoved: boolean | null;
  /** What the signed-in player may do with it. */
  yourTurn: 'report' | 'confirm' | 'wait' | null;
  purse: { pushed: boolean; error: { code: string; message: string } | null };
  updatedAt: string;
};

export type SeasonView = {
  id: string;
  title: string;
  status: Season['status'];
  commissioner: PublicPlayer;
  youAreCommissioner: boolean;
  youAreIn: boolean;
  entryPoints: string;
  challengeReach: number;
  ladder: LadderRow[];
  matches: MatchView[];
  purse: { contestId: string | null; contestState: string | null };
  frozenPreview: Season['purseClosePreview'];
  settlement: Season['purseSettlement'];
  startedAt: string | null;
  closedAt: string | null;
};

/** The season on the board: the newest one that is not closed, else the newest closed one, else null. */
export async function currentSeason(db: DbOrTx): Promise<Season | null> {
  const [open] = await db.select().from(seasons).where(ne(seasons.status, 'closed')).orderBy(desc(seasons.createdAt)).limit(1);
  if (open !== undefined) return open;
  const [last] = await db.select().from(seasons).orderBy(desc(seasons.createdAt)).limit(1);
  return last ?? null;
}

export async function openSeason(db: Db, input: { title: string; commissioner: Player; now: Date }): Promise<Season> {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length === 0 || title.length > 60) throw failure.invalidRequest('title_invalid', 'Give the season a title of up to 60 characters.');
  return db.transaction(async (tx) => {
    // One season at a time; the advisory lock serialises two people opening one together.
    await tx.execute(`select pg_advisory_xact_lock(hashtext('pingpong:open-season'))`);
    const [running] = await tx.select({ id: seasons.id }).from(seasons).where(ne(seasons.status, 'closed')).limit(1);
    if (running !== undefined) throw failure.conflict('season_already_open', 'A season is already running; close it before opening the next.');
    const [created] = await tx
      .insert(seasons)
      .values({ id: newId('ssn'), title, status: 'enrolling', commissionerId: input.commissioner.id, purseExternalId: `pp-${newId('ssn')}`, createdAt: input.now, updatedAt: input.now })
      .returning();
    if (created === undefined) throw new Error('season insert returned no row');
    return created;
  });
}

/** Start play: at least two on the ladder, then the Purse contest is locked and started, then the season is `playing`. */
export async function startSeason(deps: PurseDeps, input: { seasonId: string; actor: Player; requestId: string; now: Date }): Promise<Season> {
  const season = await deps.db.transaction(async (tx) => {
    const locked = await lockSeason(tx, input.seasonId);
    if (locked.commissionerId !== input.actor.id) throw failure.permission('commissioner_only', 'Only the commissioner starts the season.');
    if (locked.status !== 'enrolling') throw failure.invalidState('season_not_enrolling', `The season is ${locked.status}.`);
    const entries = await tx.select({ id: seasonEntries.id }).from(seasonEntries).where(eq(seasonEntries.seasonId, locked.id));
    if (entries.length < 2) throw failure.invalidState('not_enough_players', 'A season needs at least two players on the ladder before it starts.');
    const [updated] = await tx.update(seasons).set({ status: 'playing', startedAt: input.now, updatedAt: input.now }).where(eq(seasons.id, locked.id)).returning();
    if (updated === undefined) throw new Error('season vanished mid-start');
    return updated;
  });
  // After the commit: Purse locks and starts the contest. Idempotent; a failure here leaves
  // the season playing and the next Purse-facing step runs the same mirror again.
  const contest = await ensureMirroredContest(deps, season, { requestId: input.requestId, now: input.now });
  return { ...season, purseContestId: contest.id, purseContestState: contest.state };
}

export async function seasonView(db: DbOrTx, season: Season, viewer: Player | null): Promise<SeasonView> {
  const entries: SeasonEntry[] = await db.select().from(seasonEntries).where(eq(seasonEntries.seasonId, season.id)).orderBy(asc(seasonEntries.rank));
  const matches = await db.select().from(ladderMatches).where(eq(ladderMatches.seasonId, season.id)).orderBy(desc(ladderMatches.updatedAt), desc(ladderMatches.id));
  const ids = new Set<string>([season.commissionerId, ...entries.map((e) => e.playerId), ...matches.flatMap((m) => [m.challengerId, m.defenderId])]);
  const people = ids.size === 0 ? [] : await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, [...ids]));
  const nameOf = new Map(people.map((p) => [p.id, publicPlayer(p)]));
  const person = (id: string): PublicPlayer => nameOf.get(id) ?? { id, name: 'Unknown' };
  const open = matches.filter((m) => m.status === 'challenged' || m.status === 'reported');
  const mine = viewer === null ? undefined : entries.find((e) => e.playerId === viewer.id);
  const busy = new Set(open.flatMap((m) => [m.challengerId, m.defenderId]));
  return {
    id: season.id,
    title: season.title,
    status: season.status,
    commissioner: person(season.commissionerId),
    youAreCommissioner: viewer !== null && viewer.id === season.commissionerId,
    youAreIn: mine !== undefined,
    entryPoints: SEASON_ENTRY_POINTS.toString(),
    challengeReach: CHALLENGE_REACH,
    ladder: entries.map((e) => ({
      rank: e.rank,
      player: person(e.playerId),
      wins: e.wins,
      losses: e.losses,
      you: viewer?.id === e.playerId,
      challengeable: season.status === 'playing' && mine !== undefined && !busy.has(mine.playerId) && !busy.has(e.playerId) && e.rank < mine.rank && mine.rank - e.rank <= CHALLENGE_REACH,
    })),
    matches: matches.map((m) => ({
      id: m.id,
      status: m.status,
      challenger: person(m.challengerId),
      defender: person(m.defenderId),
      challengerScore: m.challengerScore,
      defenderScore: m.defenderScore,
      reportedBy: m.reportedById === null ? null : person(m.reportedById),
      winner: m.winnerId === null ? null : person(m.winnerId),
      ladderMoved: m.ladderMoved,
      yourTurn: turnFor(m, viewer),
      purse: { pushed: m.pursePushedAt !== null, error: m.pursePushError === null ? null : { code: m.pursePushError.code, message: m.pursePushError.message } },
      updatedAt: m.updatedAt.toISOString(),
    })),
    purse: { contestId: season.purseContestId, contestState: season.purseContestState },
    frozenPreview: season.purseClosePreview,
    settlement: season.purseSettlement,
    startedAt: season.startedAt?.toISOString() ?? null,
    closedAt: season.closedAt?.toISOString() ?? null,
  };
}

function turnFor(match: LadderMatch, viewer: Player | null): MatchView['yourTurn'] {
  if (viewer === null || (viewer.id !== match.challengerId && viewer.id !== match.defenderId)) return null;
  if (match.status === 'challenged') return 'report';
  if (match.status === 'reported') return match.reportedById === viewer.id ? 'wait' : 'confirm';
  return null;
}

/** The season's entry row for a player, if they are on the ladder. */
export async function entryFor(db: DbOrTx, seasonId: string, playerId: string): Promise<SeasonEntry | undefined> {
  const [entry] = await db.select().from(seasonEntries).where(and(eq(seasonEntries.seasonId, seasonId), eq(seasonEntries.playerId, playerId)));
  return entry;
}
