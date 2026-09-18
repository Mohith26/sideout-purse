import type { MatchStatus, TournamentFormat } from '../db/schema';
import { compareAcrossPools, levelAcrossPools, type StandingRow } from './standings';
import { isMatchComplete } from './state';

/**
 * The final standings of a whole tournament: one placement per team, tied teams sharing
 * a placement in competition ranking (1, 2, 3, 3, 5). Pure; the services build the input
 * from rows. This is the outcome Sideout owns (spec, "the four rules", rule 3) and what
 * it pushes to Purse as each player's finished score once every match is complete, so
 * Purse's settlement ranks players exactly as this function does (`purse-score.ts`).
 *
 * - A bracket places by the round a team was eliminated in: the winner of the final is
 *   first, its loser second, the losers of the semifinals share third, and so on down;
 *   byes are not results, and a team reaching a round by a bye places by the round it
 *   left.
 * - A pool-to-bracket event places the teams the bracket left out after every bracket
 *   team, ordered across pools the way the bracket draw ranks them (`compareAcrossPools`);
 *   teams level on every key share a placement.
 * - A round robin's placements are its pool standings' ranks.
 */
export type FinalStandingsMatch = {
  id: string;
  round: number;
  bracketPosition: number | null;
  status: MatchStatus;
  teamAId: string | null;
  teamBId: string | null;
  winnerTeamId: string | null;
};

export type FinalStandingsInput = {
  format: TournamentFormat;
  /** Every team the standings must place: the teams the draw covered. */
  teamIds: readonly string[];
  matches: readonly FinalStandingsMatch[];
  /** The pool standings (cut-line lots already applied); empty for single elimination. */
  pools: ReadonlyArray<{ standings: readonly StandingRow[] }>;
};

export type FinalPlacement = { teamId: string; placement: number };

export class FinalStandingsError extends Error {
  override readonly name = 'FinalStandingsError';
  constructor(
    readonly code: 'matches_incomplete' | 'bracket_missing' | 'no_champion' | 'team_unplaced',
    message: string,
  ) {
    super(message);
  }
}

/** Ordered groups of teams, best first, into competition-ranked placements. */
function rankGroups(groups: ReadonlyArray<readonly string[]>): FinalPlacement[] {
  const out: FinalPlacement[] = [];
  let placed = 0;
  for (const group of groups) {
    if (group.length === 0) continue;
    const placement = placed + 1;
    for (const teamId of [...group].sort()) out.push({ teamId, placement });
    placed += group.length;
  }
  return out;
}

/**
 * Bracket placement groups, best first: the champion, the runner-up, then the losers of
 * each earlier round together. Only complete matches count (a bye is complete and has no
 * loser).
 */
function bracketGroups(matches: readonly FinalStandingsMatch[]): string[][] {
  const bracket = matches.filter((m) => m.bracketPosition !== null);
  if (bracket.length === 0) throw new FinalStandingsError('bracket_missing', 'The bracket has not been drawn; there is no champion.');
  const incomplete = bracket.filter((m) => !isMatchComplete(m.status));
  if (incomplete.length > 0) {
    throw new FinalStandingsError('matches_incomplete', `${incomplete.length} bracket match(es) are not complete: ${incomplete.map((m) => m.id).join(', ')}.`);
  }
  const rounds = Math.max(...bracket.map((m) => m.round));
  const final = bracket.filter((m) => m.round === rounds);
  const champion = final.length === 1 ? (final[0]?.winnerTeamId ?? null) : null;
  if (champion === null) throw new FinalStandingsError('no_champion', 'The final has no winner.');

  const groups: string[][] = [[champion]];
  for (let round = rounds; round >= 1; round -= 1) {
    const losers: string[] = [];
    for (const m of bracket.filter((x) => x.round === round && x.status !== 'bye')) {
      const loser = m.winnerTeamId === m.teamAId ? m.teamBId : m.winnerTeamId === m.teamBId ? m.teamAId : null;
      if (loser !== null) losers.push(loser);
    }
    groups.push(losers);
  }
  return groups;
}

/** Teams outside the bracket, grouped across pools by the draw's cross-pool order; level teams share a group. */
function poolOnlyGroups(pools: FinalStandingsInput['pools'], exclude: ReadonlySet<string>): string[][] {
  const rows = pools.flatMap((pool) => pool.standings).filter((row) => !exclude.has(row.teamId));
  // Pool rank first (a pool winner left out by a cut line never places below a runner-up), then the draw's order.
  rows.sort((x, y) => x.rank - y.rank || compareAcrossPools(x, y));
  return groupWhile(rows, (previous, row) => previous.rank === row.rank && levelAcrossPools(previous, row));
}

/** Consecutive rows into groups, a row joining the last group when `together` says it belongs with that group's first row. */
function groupWhile(rows: readonly StandingRow[], together: (first: StandingRow, row: StandingRow) => boolean): string[][] {
  const groups: Array<{ first: StandingRow; teamIds: string[] }> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && together(last.first, row)) last.teamIds.push(row.teamId);
    else groups.push({ first: row, teamIds: [row.teamId] });
  }
  return groups.map((g) => g.teamIds);
}

export function finalStandings(input: FinalStandingsInput): FinalPlacement[] {
  const incomplete = input.matches.filter((m) => !isMatchComplete(m.status));
  if (incomplete.length > 0) {
    throw new FinalStandingsError('matches_incomplete', `${incomplete.length} match(es) are not complete: ${incomplete.map((m) => m.id).join(', ')}.`);
  }
  let groups: string[][];
  if (input.format === 'round_robin') {
    const rows = input.pools.flatMap((pool) => pool.standings).sort((x, y) => x.rank - y.rank || compareAcrossPools(x, y));
    groups = groupWhile(rows, (previous, row) => previous.rank === row.rank);
  } else {
    const bracket = bracketGroups(input.matches);
    const placed = new Set(bracket.flat());
    groups = [...bracket, ...poolOnlyGroups(input.pools, placed)];
  }
  const placements = rankGroups(groups);
  const seen = new Set(placements.map((p) => p.teamId));
  const unplaced = input.teamIds.filter((id) => !seen.has(id));
  if (unplaced.length > 0) throw new FinalStandingsError('team_unplaced', `${unplaced.length} team(s) have no placement: ${unplaced.join(', ')}.`);
  return placements.filter((p) => input.teamIds.includes(p.teamId));
}
