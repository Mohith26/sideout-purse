import { asc, eq, inArray } from 'drizzle-orm';

import { matches, pools, poolTeams, sets, type Match, type Pool, type PoolTeam, type SetRow } from '../db/schema';
import { computeStandings, type StandingRow, type StandingsMatch } from '../domain/standings';
import { isMatchComplete } from '../domain/state';
import type { DbOrTx } from './db';

/**
 * Standings are computed from `sets` and match results on every read; nothing stores a
 * rank. A pool's standings count its complete matches (`final` and `forfeited`); a match
 * still in play contributes nothing until it is decided.
 */

export type PoolStage = {
  pools: Pool[];
  poolTeams: PoolTeam[];
  matches: Match[];
  sets: SetRow[];
};

export async function loadPoolStage(db: DbOrTx, tournamentId: string): Promise<PoolStage> {
  const poolRows = await db.select().from(pools).where(eq(pools.tournamentId, tournamentId)).orderBy(asc(pools.sequence));
  const poolIds = poolRows.map((p) => p.id);
  const poolTeamRows = poolIds.length === 0 ? [] : await db.select().from(poolTeams).where(inArray(poolTeams.poolId, poolIds));
  const matchRows = await db.select().from(matches).where(eq(matches.tournamentId, tournamentId)).orderBy(asc(matches.round), asc(matches.id));
  const matchIds = matchRows.map((m) => m.id);
  const setRows = matchIds.length === 0 ? [] : await db.select().from(sets).where(inArray(sets.matchId, matchIds));
  return { pools: poolRows, poolTeams: poolTeamRows, matches: matchRows, sets: setRows };
}

/** The results a standings computation sees: complete matches with their sets, oriented from team A. */
export function toStandingsMatches(matchRows: readonly Match[], setRows: readonly SetRow[]): StandingsMatch[] {
  const out: StandingsMatch[] = [];
  for (const m of matchRows) {
    if (!isMatchComplete(m.status) || m.status === 'bye') continue;
    if (m.teamAId === null || m.teamBId === null || m.winnerTeamId === null) continue;
    out.push({
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      winnerTeamId: m.winnerTeamId,
      sets: setRows
        .filter((s) => s.matchId === m.id)
        .sort((x, y) => x.setNumber - y.setNumber)
        .map((s) => ({ teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints })),
    });
  }
  return out;
}

export type PoolStandings = { poolId: string; label: string; sequence: number; standings: StandingRow[] };

export function standingsForStage(stage: PoolStage): PoolStandings[] {
  return stage.pools.map((pool) => {
    const teamIds = stage.poolTeams
      .filter((pt) => pt.poolId === pool.id)
      .sort((x, y) => x.position - y.position)
      .map((pt) => pt.teamId);
    const poolMatches = stage.matches.filter((m) => m.poolId === pool.id);
    return {
      poolId: pool.id,
      label: pool.label,
      sequence: pool.sequence,
      standings: computeStandings(teamIds, toStandingsMatches(poolMatches, stage.sets)),
    };
  });
}

export async function tournamentStandings(db: DbOrTx, tournamentId: string): Promise<PoolStandings[]> {
  return standingsForStage(await loadPoolStage(db, tournamentId));
}
