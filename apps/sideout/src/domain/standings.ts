/**
 * Pool standings with the full tiebreak order. Pure; every figure is derived from the
 * matches passed in, which the services build from `sets` rows, so a standing can never
 * be typed.
 *
 * Tiebreak order (`STANDINGS_TIEBREAK_ORDER`):
 *
 * 1. **wins**, descending.
 * 2. **head-to-head**, only when exactly two teams are tied on wins and they have met
 *    with a decided result: the winner of that meeting ranks first. Three or more tied
 *    teams skip this step (a circular head-to-head cannot order them), as do two teams
 *    who have not played each other yet.
 * 3. **set ratio**, sets won over sets played, descending. Compared as exact fractions,
 *    never as floats; a team with no sets played has ratio 0.
 * 4. **point differential**, points for minus points against, descending.
 * 5. **points for**, descending.
 * 6. **team id**, ascending, so the order is total and deterministic.
 *
 * Teams still level after step 5 share a rank; step 6 only fixes their display order.
 */

export const STANDINGS_TIEBREAK_ORDER = [
  'wins',
  'head_to_head',
  'set_ratio',
  'point_differential',
  'points_for',
  'team_id',
] as const;

export type StandingsMatch = {
  teamAId: string;
  teamBId: string;
  winnerTeamId: string;
  /** Oriented from team A's side. A forfeit contributes a win and a loss but no sets. */
  sets: ReadonlyArray<{ teamAPoints: number; teamBPoints: number }>;
};

export type StandingRow = {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  setsWon: number;
  setsLost: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  /** One-based; tied teams share a rank and the next rank skips accordingly. */
  rank: number;
};

function emptyRow(teamId: string): StandingRow {
  return {
    teamId,
    played: 0,
    wins: 0,
    losses: 0,
    setsWon: 0,
    setsLost: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointDiff: 0,
    rank: 0,
  };
}

/**
 * Sign of `a/aDen - b/bDen` by integer cross-multiplication, so ratios are compared
 * exactly. A zero denominator is read as zero.
 */
export function compareFractions(aNum: number, aDen: number, bNum: number, bDen: number): number {
  const [an, ad] = aDen === 0 ? [0, 1] : [aNum, aDen];
  const [bn, bd] = bDen === 0 ? [0, 1] : [bNum, bDen];
  const left = an * bd;
  const right = bn * ad;
  return left === right ? 0 : left > right ? 1 : -1;
}

function compareIds(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Steps 3 to 6: the comparator applied within a group of teams tied on wins, after the
 * head-to-head step has had its chance. Descending on every metric, then id ascending.
 */
export function compareAfterHeadToHead(x: StandingRow, y: StandingRow): number {
  const ratio = compareFractions(y.setsWon, y.setsWon + y.setsLost, x.setsWon, x.setsWon + x.setsLost);
  if (ratio !== 0) return ratio;
  if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
  if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
  return compareIds(x.teamId, y.teamId);
}

/**
 * The whole order without head-to-head: wins, then steps 3 to 6. This is what ranks
 * teams across different pools, where head-to-head has no meaning.
 */
export function compareStandings(x: StandingRow, y: StandingRow): number {
  if (y.wins !== x.wins) return y.wins - x.wins;
  return compareAfterHeadToHead(x, y);
}

/**
 * Cross-pool comparator for bracket seeding: pools may differ in size by one, so wins are
 * compared as a fraction of matches played before falling through to the same tiebreaks.
 */
export function compareAcrossPools(x: StandingRow, y: StandingRow): number {
  const winRate = compareFractions(y.wins, y.played, x.wins, x.played);
  if (winRate !== 0) return winRate;
  if (y.wins !== x.wins) return y.wins - x.wins;
  return compareAfterHeadToHead(x, y);
}

/** True when two rows are level on every competitive key (steps 1, 3, 4, 5). */
function levelOnCompetitiveKeys(x: StandingRow, y: StandingRow): boolean {
  return (
    x.wins === y.wins &&
    compareFractions(x.setsWon, x.setsWon + x.setsLost, y.setsWon, y.setsWon + y.setsLost) === 0 &&
    x.pointDiff === y.pointDiff &&
    x.pointsFor === y.pointsFor
  );
}

/** The winner of the meetings between two teams, or null when undecided or unplayed. */
function headToHeadWinner(a: string, b: string, matches: readonly StandingsMatch[]): string | null {
  let aWins = 0;
  let bWins = 0;
  for (const m of matches) {
    const between = (m.teamAId === a && m.teamBId === b) || (m.teamAId === b && m.teamBId === a);
    if (!between) continue;
    if (m.winnerTeamId === a) aWins += 1;
    else if (m.winnerTeamId === b) bWins += 1;
  }
  if (aWins === bWins) return null;
  return aWins > bWins ? a : b;
}

export function computeStandings(teamIds: readonly string[], matches: readonly StandingsMatch[]): StandingRow[] {
  const rows = new Map<string, StandingRow>(teamIds.map((id) => [id, emptyRow(id)]));
  if (rows.size !== teamIds.length) throw new Error('standings: duplicate team id');

  for (const m of matches) {
    const a = rows.get(m.teamAId);
    const b = rows.get(m.teamBId);
    if (a === undefined || b === undefined) {
      throw new Error(`standings: match references a team outside the pool (${m.teamAId} vs ${m.teamBId})`);
    }
    if (m.teamAId === m.teamBId) throw new Error('standings: a team cannot play itself');
    if (m.winnerTeamId !== m.teamAId && m.winnerTeamId !== m.teamBId) {
      throw new Error(`standings: winner ${m.winnerTeamId} is not a participant`);
    }
    a.played += 1;
    b.played += 1;
    if (m.winnerTeamId === m.teamAId) {
      a.wins += 1;
      b.losses += 1;
    } else {
      b.wins += 1;
      a.losses += 1;
    }
    for (const s of m.sets) {
      a.pointsFor += s.teamAPoints;
      a.pointsAgainst += s.teamBPoints;
      b.pointsFor += s.teamBPoints;
      b.pointsAgainst += s.teamAPoints;
      if (s.teamAPoints > s.teamBPoints) {
        a.setsWon += 1;
        b.setsLost += 1;
      } else if (s.teamBPoints > s.teamAPoints) {
        b.setsWon += 1;
        a.setsLost += 1;
      }
    }
  }

  const all = [...rows.values()].map((r) => ({ ...r, pointDiff: r.pointsFor - r.pointsAgainst }));

  // Step 1: group by wins, descending.
  const groups = new Map<number, StandingRow[]>();
  for (const row of all) {
    const group = groups.get(row.wins) ?? [];
    group.push(row);
    groups.set(row.wins, group);
  }
  const winCounts = [...groups.keys()].sort((x, y) => y - x);

  const ordered: StandingRow[] = [];
  for (const wins of winCounts) {
    const group = groups.get(wins) ?? [];
    if (group.length === 2) {
      const [x, y] = group as [StandingRow, StandingRow];
      const winner = headToHeadWinner(x.teamId, y.teamId, matches);
      if (winner !== null) {
        // Step 2 decided it: distinct ranks regardless of the remaining keys.
        const first = winner === x.teamId ? x : y;
        const second = first === x ? y : x;
        first.rank = ordered.length + 1;
        second.rank = ordered.length + 2;
        ordered.push(first, second);
        continue;
      }
    }
    group.sort(compareAfterHeadToHead);
    for (let i = 0; i < group.length; i += 1) {
      const row = group[i];
      const prev = group[i - 1];
      if (row === undefined) continue;
      const tied = prev !== undefined && levelOnCompetitiveKeys(prev, row);
      row.rank = tied && prev !== undefined ? prev.rank : ordered.length + 1;
      ordered.push(row);
    }
  }
  return ordered;
}
