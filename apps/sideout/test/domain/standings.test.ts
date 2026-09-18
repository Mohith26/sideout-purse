import { describe, expect, it } from 'vitest';

import {
  compareAcrossPools,
  compareFractions,
  computeStandings,
  STANDINGS_TIEBREAK_ORDER,
  type StandingsMatch,
} from '../../src/domain/standings';

const A = 'team-a';
const B = 'team-b';
const C = 'team-c';
const D = 'team-d';

const one = (teamAId: string, teamBId: string, a: number, b: number): StandingsMatch => ({
  teamAId,
  teamBId,
  winnerTeamId: a > b ? teamAId : teamBId,
  sets: [{ teamAPoints: a, teamBPoints: b }],
});

const three = (teamAId: string, teamBId: string, sets: Array<[number, number]>): StandingsMatch => {
  const aSets = sets.filter(([a, b]) => a > b).length;
  return {
    teamAId,
    teamBId,
    winnerTeamId: aSets * 2 > sets.length ? teamAId : teamBId,
    sets: sets.map(([teamAPoints, teamBPoints]) => ({ teamAPoints, teamBPoints })),
  };
};

describe('computeStandings', () => {
  it('ranks by wins, then point differential, then points for', () => {
    const rows = computeStandings(
      [A, B, C, D],
      [one(A, B, 21, 15), one(C, D, 21, 19), one(A, C, 18, 21), one(B, D, 12, 21), one(A, D, 21, 10), one(B, C, 20, 22)],
    );
    expect(rows.map((r) => r.teamId)).toEqual([C, A, D, B]);
    const c = rows[0];
    expect(c).toMatchObject({ wins: 3, losses: 0, played: 3, pointsFor: 64, pointsAgainst: 57, pointDiff: 7, rank: 1 });
    const a = rows[1];
    expect(a).toMatchObject({ wins: 2, losses: 1, pointDiff: 21 - 15 + 18 - 21 + 21 - 10, rank: 2 });
    expect(rows[3]).toMatchObject({ teamId: B, wins: 0, rank: 4 });
  });

  it('shares a rank on a full tie and breaks by point differential otherwise', () => {
    const rows = computeStandings([A, B, C], [one(A, B, 21, 10), one(B, C, 21, 10), one(C, A, 21, 10)]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1]);

    const broken = computeStandings([A, B, C], [one(A, B, 21, 10), one(B, C, 21, 15), one(C, A, 21, 19)]);
    // A +9, C -4, B -5 on point differential with everyone at one win.
    expect(broken.map((r) => r.teamId)).toEqual([A, C, B]);
    expect(broken.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('rejects matches that reference teams outside the pool or an impossible winner', () => {
    expect(() => computeStandings([A, B], [{ teamAId: A, teamBId: C, winnerTeamId: A, sets: [] }])).toThrow(/outside the pool/);
    expect(() => computeStandings([A, B], [{ teamAId: A, teamBId: B, winnerTeamId: C, sets: [] }])).toThrow(/not a participant/);
  });
});

describe('tiebreak order', () => {
  it('is documented in the order the code applies it', () => {
    expect(STANDINGS_TIEBREAK_ORDER).toEqual(['wins', 'head_to_head', 'set_ratio', 'point_differential', 'points_for', 'team_id']);
  });

  it('head-to-head decides exactly two teams tied on wins, ahead of every later key', () => {
    // A and B both finish 2–1. A's differential is far better, but B beat A.
    const rows = computeStandings(
      [A, B, C, D],
      [one(A, B, 19, 21), one(A, C, 21, 5), one(A, D, 21, 5), one(B, C, 21, 19), one(B, D, 21, 19), one(C, D, 21, 15)],
    );
    expect(rows.map((r) => r.teamId)).toEqual([B, A, C, D]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('skips head-to-head when three or more are tied, and uses set ratio next', () => {
    // A, B, C each beat one of the others (circular) and each beat D. Best-of-three so set ratios differ.
    const rows = computeStandings(
      [A, B, C, D],
      [
        three(A, B, [[21, 15], [21, 15]]), // A 2–0
        three(B, C, [[21, 15], [15, 21], [15, 10]]), // B 2–1
        three(C, A, [[21, 15], [15, 21], [15, 10]]), // C 2–1
        three(A, D, [[21, 10], [21, 10]]), // A 2–0
        three(B, D, [[21, 10], [21, 10]]), // B 2–0
        three(C, D, [[21, 10], [21, 10]]), // C 2–0
      ],
    );
    // A: sets 5–2 (0.71). C: sets 5–3 (0.63). B: sets 4–3 (0.57). Head-to-head is circular and ignored.
    expect(rows.map((r) => r.teamId)).toEqual([A, C, B, D]);
    expect(rows.map((r) => r.wins)).toEqual([2, 2, 2, 0]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ setsWon: 5, setsLost: 2 });
  });

  it('set ratio comes before point differential', () => {
    // A and B are tied on wins and have not met. A won 2–0 narrowly; B won 2–1 with a huge first set.
    const rows = computeStandings(
      [A, B, C, D],
      [three(A, C, [[21, 19], [21, 19]]), three(B, D, [[21, 5], [19, 21], [15, 13]])],
    );
    const a = rows.find((r) => r.teamId === A);
    const b = rows.find((r) => r.teamId === B);
    expect(a?.pointDiff).toBe(4);
    expect(b?.pointDiff).toBe(16);
    expect(rows.map((r) => r.teamId).slice(0, 2)).toEqual([A, B]);
  });

  it('points for breaks a tie on differential', () => {
    const rows = computeStandings([A, B, C, D], [one(A, C, 25, 23), one(B, D, 21, 19)]);
    // Both +2 with one win and one set each; A scored 25 to B's 21.
    expect(rows.map((r) => r.teamId).slice(0, 2)).toEqual([A, B]);
    expect(rows.map((r) => r.rank).slice(0, 2)).toEqual([1, 2]);
  });

  it('teams level on every competitive key share a rank and are ordered by id', () => {
    const rows = computeStandings([B, A, C, D], [one(A, C, 21, 10), one(B, D, 21, 10)]);
    expect(rows.map((r) => r.teamId)).toEqual([A, B, C, D]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 3, 3]);
  });

  it('a forfeit counts as a win and a loss with no sets', () => {
    const rows = computeStandings([A, B], [{ teamAId: A, teamBId: B, winnerTeamId: B, sets: [] }]);
    expect(rows[0]).toMatchObject({ teamId: B, wins: 1, setsWon: 0, setsLost: 0, pointsFor: 0, rank: 1 });
    expect(rows[1]).toMatchObject({ teamId: A, losses: 1, rank: 2 });
  });

  it('compares ratios exactly, reading no sets played as zero', () => {
    expect(compareFractions(1, 3, 1, 3)).toBe(0);
    expect(compareFractions(2, 3, 1, 2)).toBe(1);
    expect(compareFractions(1, 3, 1, 2)).toBe(-1);
    expect(compareFractions(0, 0, 1, 2)).toBe(-1);
    expect(compareFractions(0, 0, 0, 0)).toBe(0);
    expect(compareFractions(0, 0, 0, 4)).toBe(0);
  });

  it('ranks across pools by win rate first so a three-team pool is not penalised', () => {
    const twoOfTwo = { ...computeStandings([A, B], [one(A, B, 21, 10)])[0]!, played: 2, wins: 2 };
    const twoOfThree = { ...computeStandings([C, D], [one(C, D, 21, 10)])[0]!, played: 3, wins: 2 };
    expect(compareAcrossPools(twoOfTwo, twoOfThree)).toBeLessThan(0);
  });
});
