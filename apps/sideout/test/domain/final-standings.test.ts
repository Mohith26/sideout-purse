import { describe, expect, it } from 'vitest';

import { finalStandings, FinalStandingsError, type FinalStandingsMatch } from '../../src/domain/final-standings';
import { DEFAULT_PRIZE_STRUCTURE, finalScore, finalScores, PURSE_ENTRY_POINTS, prizeStructureFor, runningScore } from '../../src/domain/purse-score';
import { computeStandings, type StandingRow } from '../../src/domain/standings';

/** A four-team single-elimination bracket: 1 v 4, 2 v 3, then the final. */
function bracket(winners: { semi1: 'A' | 'D'; semi2: 'B' | 'C'; final: 'X' | 'Y' }): FinalStandingsMatch[] {
  const semi1Winner = winners.semi1 === 'A' ? 'tm_a' : 'tm_d';
  const semi2Winner = winners.semi2 === 'B' ? 'tm_b' : 'tm_c';
  return [
    { id: 'mch_1', round: 1, bracketPosition: 1, status: 'final', teamAId: 'tm_a', teamBId: 'tm_d', winnerTeamId: semi1Winner },
    { id: 'mch_2', round: 1, bracketPosition: 2, status: 'final', teamAId: 'tm_b', teamBId: 'tm_c', winnerTeamId: semi2Winner },
    { id: 'mch_3', round: 2, bracketPosition: 3, status: 'final', teamAId: semi1Winner, teamBId: semi2Winner, winnerTeamId: winners.final === 'X' ? semi1Winner : semi2Winner },
  ];
}

function row(teamId: string, wins: number, rank: number, extra: Partial<StandingRow> = {}): StandingRow {
  return { teamId, played: 3, wins, losses: 3 - wins, setsWon: wins, setsLost: 3 - wins, pointsFor: 21 * wins, pointsAgainst: 21 * (3 - wins), pointDiff: 21 * (2 * wins - 3), rank, tiebreak: null, ...extra };
}

describe('finalStandings', () => {
  it('places a single-elimination bracket by the round each team left, semifinal losers sharing third', () => {
    const placements = finalStandings({ format: 'single_elim', teamIds: ['tm_a', 'tm_b', 'tm_c', 'tm_d'], matches: bracket({ semi1: 'A', semi2: 'C', final: 'Y' }), pools: [] });
    expect(placements).toEqual([
      { teamId: 'tm_c', placement: 1 },
      { teamId: 'tm_a', placement: 2 },
      { teamId: 'tm_b', placement: 3 },
      { teamId: 'tm_d', placement: 3 },
    ]);
  });

  it('places a bye like any other route into a round', () => {
    const matches: FinalStandingsMatch[] = [
      { id: 'mch_1', round: 1, bracketPosition: 1, status: 'bye', teamAId: 'tm_a', teamBId: null, winnerTeamId: 'tm_a' },
      { id: 'mch_2', round: 1, bracketPosition: 2, status: 'final', teamAId: 'tm_b', teamBId: 'tm_c', winnerTeamId: 'tm_b' },
      { id: 'mch_3', round: 2, bracketPosition: 3, status: 'forfeited', teamAId: 'tm_a', teamBId: 'tm_b', winnerTeamId: 'tm_b' },
    ];
    expect(finalStandings({ format: 'single_elim', teamIds: ['tm_a', 'tm_b', 'tm_c'], matches, pools: [] })).toEqual([
      { teamId: 'tm_b', placement: 1 },
      { teamId: 'tm_a', placement: 2 },
      { teamId: 'tm_c', placement: 3 },
    ]);
  });

  it('places the teams a pool-to-bracket left out after every bracket team, by pool rank then the cross-pool order', () => {
    const pools = [
      { standings: [row('tm_a', 3, 1), row('tm_c', 2, 2), row('tm_e', 1, 3), row('tm_g', 0, 4)] },
      { standings: [row('tm_b', 3, 1), row('tm_d', 2, 2), row('tm_f', 1, 3, { pointDiff: -30 }), row('tm_h', 0, 4)] },
    ];
    const placements = finalStandings({ format: 'pool_to_bracket', teamIds: ['tm_a', 'tm_b', 'tm_c', 'tm_d', 'tm_e', 'tm_f', 'tm_g', 'tm_h'], matches: bracket({ semi1: 'A', semi2: 'B', final: 'X' }), pools });
    expect(placements).toEqual([
      { teamId: 'tm_a', placement: 1 },
      { teamId: 'tm_b', placement: 2 },
      { teamId: 'tm_c', placement: 3 },
      { teamId: 'tm_d', placement: 3 },
      // Third in each pool: tm_f's point differential is worse, so tm_e is fifth on its own.
      { teamId: 'tm_e', placement: 5 },
      { teamId: 'tm_f', placement: 6 },
      // Last in each pool and level on every key: they share seventh.
      { teamId: 'tm_g', placement: 7 },
      { teamId: 'tm_h', placement: 7 },
    ]);
  });

  it('places a round robin by its standings, ties shared', () => {
    const standings = computeStandings(
      ['tm_a', 'tm_b', 'tm_c'],
      [
        { teamAId: 'tm_a', teamBId: 'tm_b', winnerTeamId: 'tm_a', sets: [{ teamAPoints: 21, teamBPoints: 15 }] },
        { teamAId: 'tm_b', teamBId: 'tm_c', winnerTeamId: 'tm_b', sets: [{ teamAPoints: 21, teamBPoints: 15 }] },
        { teamAId: 'tm_c', teamBId: 'tm_a', winnerTeamId: 'tm_c', sets: [{ teamAPoints: 21, teamBPoints: 15 }] },
      ],
    );
    const matches: FinalStandingsMatch[] = [1, 2, 3].map((n) => ({ id: `mch_${n}`, round: n, bracketPosition: null, status: 'final', teamAId: 'tm_a', teamBId: 'tm_b', winnerTeamId: 'tm_a' }));
    const placements = finalStandings({ format: 'round_robin', teamIds: ['tm_a', 'tm_b', 'tm_c'], matches, pools: [{ standings }] });
    // A three-way circle, identical set and point figures: one shared placement.
    expect(placements.map((p) => p.placement)).toEqual([1, 1, 1]);
  });

  it('refuses incomplete matches, a missing bracket and a team it cannot place, each by name', () => {
    const matches = bracket({ semi1: 'A', semi2: 'B', final: 'X' });
    const [first] = matches;
    if (first === undefined) throw new Error('fixture');
    const incomplete = [{ ...first, status: 'awaiting_scores' as const, winnerTeamId: null }, ...matches.slice(1)];
    expect(() => finalStandings({ format: 'single_elim', teamIds: ['tm_a'], matches: incomplete, pools: [] })).toThrow(FinalStandingsError);
    expect(() => finalStandings({ format: 'single_elim', teamIds: ['tm_a'], matches: incomplete, pools: [] })).toThrow(/mch_1/);
    expect(() => finalStandings({ format: 'pool_to_bracket', teamIds: ['tm_a'], matches: [], pools: [] })).toThrow(/bracket has not been drawn/);
    expect(() => finalStandings({ format: 'single_elim', teamIds: ['tm_a', 'tm_b', 'tm_c', 'tm_d', 'tm_z'], matches, pools: [] })).toThrow(/tm_z/);
  });
});

describe('purse scores and prizes', () => {
  it('maps placements to strictly decreasing scores that tied teams share', () => {
    expect(finalScore(1, 8)).toBe(8);
    expect(finalScore(8, 8)).toBe(1);
    expect(() => finalScore(9, 8)).toThrow(RangeError);
    const scores = finalScores([
      { teamId: 'tm_c', placement: 1 },
      { teamId: 'tm_a', placement: 2 },
      { teamId: 'tm_b', placement: 3 },
      { teamId: 'tm_d', placement: 3 },
    ]);
    expect([...scores.entries()]).toEqual([
      ['tm_c', 4],
      ['tm_a', 3],
      ['tm_b', 2],
      ['tm_d', 2],
    ]);
    expect(runningScore(2)).toBe(2);
    expect(() => runningScore(-1)).toThrow(RangeError);
    expect(PURSE_ENTRY_POINTS).toBe(100n);
  });

  it('turns sponsor prize contributions into a placement table of weights, largest first, two player placements per team share', () => {
    expect(prizeStructureFor([{ prizeContributionCents: 40_000n }, { prizeContributionCents: 150_000n }, { prizeContributionCents: 60_000n }])).toEqual({
      type: 'placement_table',
      placements: [
        { placement: 1, amount: '150000' },
        { placement: 2, amount: '150000' },
        { placement: 3, amount: '60000' },
        { placement: 4, amount: '60000' },
        { placement: 5, amount: '40000' },
        { placement: 6, amount: '40000' },
      ],
    });
    expect(prizeStructureFor([])).toEqual(DEFAULT_PRIZE_STRUCTURE);
    expect(prizeStructureFor([{ prizeContributionCents: 0n }])).toEqual(DEFAULT_PRIZE_STRUCTURE);
    expect(DEFAULT_PRIZE_STRUCTURE).toEqual({
      type: 'placement_table',
      placements: [50n, 50n, 30n, 30n, 20n, 20n].map((amount, index) => ({ placement: index + 1, amount: amount.toString() })),
    });
  });
});
