import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalPayouts,
  evenSplit,
  isSettlementError,
  payoutHash,
  proportional,
  settle,
  SettlementError,
  TIE_BREAK_RULES,
  type Payout,
  type PrizeStructure,
  type SettleEntry,
  type SettleInput,
  type TieBreakRule,
} from '../../src/settlement';

/**
 * Spec 4.4 and section 8: the settlement engine as examples for every documented rule, then
 * as properties over generated contests (random entrant counts including 0 and 1, scores
 * with ties and nulls, every structure, every tie rule): conservation, non-negativity,
 * placement monotonicity, determinism under input permutation and the remainder
 * allocation. No database anywhere in this file.
 */
const u = (n: number) => `usr_${String(n).padStart(3, '0')}`;

function entries(scores: Array<number | null>, extra: Array<Partial<SettleEntry>> = []): SettleEntry[] {
  return scores.map((score, index) => ({ userId: u(index + 1), score, ...(extra[index] ?? {}) }));
}

function run(escrowTotal: bigint, scores: Array<number | null>, prizeStructure: PrizeStructure, tieBreak: TieBreakRule = 'split_evenly', extra: Array<Partial<SettleEntry>> = []): Payout[] {
  return settle({ asset: 'POINTS', escrowTotal, entries: entries(scores, extra), prizeStructure, tieBreak });
}

const byUser = (payouts: Payout[]) => Object.fromEntries(payouts.map((p) => [p.userId, p.payout]));
const placements = (payouts: Payout[]) => Object.fromEntries(payouts.map((p) => [p.userId, p.placement]));

describe('settle: the documented examples', () => {
  it('100 three ways is 34/33/33, never 33/33/33 with a lost unit', () => {
    const payouts = run(100n, [30, 20, 10], { type: 'top_n_equal', n: 3 });
    expect(payouts).toEqual([
      { userId: u(1), placement: 1, payout: 34n },
      { userId: u(2), placement: 2, payout: 33n },
      { userId: u(3), placement: 3, payout: 33n },
    ]);
  });

  it('a percentage split of [50, 30, 20] over 101 floors each share and hands the unit to first place', () => {
    expect(byUser(run(101n, [3, 2, 1], { type: 'percentage_split', percentages: [50, 30, 20] }))).toEqual({ [u(1)]: 51n, [u(2)]: 30n, [u(3)]: 20n });
    // Two units left over: first and second place.
    expect(byUser(run(7n, [3, 2, 1], { type: 'percentage_split', percentages: [50, 30, 20] }))).toEqual({ [u(1)]: 4n, [u(2)]: 2n, [u(3)]: 1n });
  });

  it('winner_take_all pays the top score everything and the rest nothing', () => {
    expect(byUser(run(300n, [5, 9, 1], { type: 'winner_take_all' }))).toEqual({ [u(1)]: 0n, [u(2)]: 300n, [u(3)]: 0n });
    expect(placements(run(300n, [5, 9, 1], { type: 'winner_take_all' }))).toEqual({ [u(2)]: 1, [u(1)]: 2, [u(3)]: 3 });
  });

  it('a single entrant in a winner_take_all receives the whole escrow, which is their own entry back', () => {
    expect(run(100n, [42], { type: 'winner_take_all' })).toEqual([{ userId: u(1), placement: 1, payout: 100n }]);
    expect(run(100n, [null], { type: 'winner_take_all' })).toEqual([{ userId: u(1), placement: 1, payout: 100n }]);
  });

  it('zero entrants settle to nothing, and a pool with nobody to pay is refused', () => {
    expect(run(0n, [], { type: 'winner_take_all' })).toEqual([]);
    expect(() => run(1n, [], { type: 'winner_take_all' })).toThrow(SettlementError);
    try {
      run(5n, [], { type: 'top_n_equal', n: 2 });
    } catch (error) {
      expect(isSettlementError(error, 'no_recipients')).toBe(true);
    }
  });

  it('unscored entrants place last, together, and receive nothing', () => {
    const payouts = run(100n, [null, 10, null, 20], { type: 'percentage_split', percentages: [60, 40] });
    expect(placements(payouts)).toEqual({ [u(4)]: 1, [u(2)]: 2, [u(1)]: 3, [u(3)]: 3 });
    expect(byUser(payouts)).toEqual({ [u(4)]: 60n, [u(2)]: 40n, [u(1)]: 0n, [u(3)]: 0n });
  });

  it('weights past the last scored placement are not used: the whole pool goes to those who placed', () => {
    // Three placements defined, two entrants scored: 50/30 renormalise to 5/8 and 3/8 of the pool.
    expect(byUser(run(80n, [10, 5, null], { type: 'percentage_split', percentages: [50, 30, 20] }))).toEqual({ [u(1)]: 50n, [u(2)]: 30n, [u(3)]: 0n });
    expect(byUser(run(80n, [10, 5], { type: 'top_n_equal', n: 5 }))).toEqual({ [u(1)]: 40n, [u(2)]: 40n });
  });

  it('a contest in which nobody scored splits the pool evenly, because nobody can be ranked', () => {
    const payouts = run(10n, [null, null, null], { type: 'winner_take_all' });
    expect(payouts).toEqual([
      { userId: u(1), placement: 1, payout: 4n },
      { userId: u(2), placement: 1, payout: 3n },
      { userId: u(3), placement: 1, payout: 3n },
    ]);
  });

  it('a placement_table of amounts pays exactly its amounts when the pool equals their total, and in proportion otherwise', () => {
    const table: PrizeStructure = { type: 'placement_table', placements: [{ placement: 1, amount: '500' }, { placement: 2, amount: '300' }, { placement: 3, amount: '200' }] };
    expect(byUser(run(1000n, [3, 2, 1], table))).toEqual({ [u(1)]: 500n, [u(2)]: 300n, [u(3)]: 200n });
    expect(byUser(run(2000n, [3, 2, 1], table))).toEqual({ [u(1)]: 1000n, [u(2)]: 600n, [u(3)]: 400n });
    expect(byUser(run(10n, [3, 2, 1], table))).toEqual({ [u(1)]: 5n, [u(2)]: 3n, [u(3)]: 2n });
    const percents: PrizeStructure = { type: 'placement_table', placements: [{ placement: 1, percent: 70 }, { placement: 2, percent: 30 }] };
    expect(byUser(run(10n, [3, 2, 1], percents))).toEqual({ [u(1)]: 7n, [u(2)]: 3n, [u(3)]: 0n });
  });

  it('guaranteed_minimum pays the floors, then the remainder by percentage; a short pool honours floors best placement first', () => {
    const structure: PrizeStructure = { type: 'guaranteed_minimum', minimums: ['100', '50'], percentages: [60, 40] };
    // Pool 250: floors 150, remainder 100 split 60/40.
    expect(byUser(run(250n, [3, 2, 1], structure))).toEqual({ [u(1)]: 160n, [u(2)]: 90n, [u(3)]: 0n });
    // Pool 120: cannot cover 150 of floors; first gets 100, second the remaining 20.
    expect(byUser(run(120n, [3, 2, 1], structure))).toEqual({ [u(1)]: 100n, [u(2)]: 20n, [u(3)]: 0n });
    // Pool 60: first gets everything.
    expect(byUser(run(60n, [3, 2, 1], structure))).toEqual({ [u(1)]: 60n, [u(2)]: 0n, [u(3)]: 0n });
    // One scored entrant: only the first floor applies, and the remainder is all theirs.
    expect(byUser(run(250n, [3, null], structure))).toEqual({ [u(1)]: 250n, [u(2)]: 0n });
  });

  it('a participation floor pays every entrant, unscored included, before the placements', () => {
    const structure: PrizeStructure = { type: 'winner_take_all', participationFloor: '10' };
    expect(byUser(run(100n, [5, null, 7], structure))).toEqual({ [u(3)]: 80n, [u(1)]: 10n, [u(2)]: 10n });
    // A pool that cannot cover the floor is split evenly instead, leftovers by placement.
    expect(byUser(run(20n, [5, null, 7], structure))).toEqual({ [u(3)]: 7n, [u(1)]: 7n, [u(2)]: 6n });
  });

  describe('ties', () => {
    const split: PrizeStructure = { type: 'percentage_split', percentages: [50, 30, 20] };

    it('split_evenly shares the combined prize of the tied placements, leftovers by ascending userId', () => {
      // Two tied for first share 50 + 30 = 80 of 100 -> 40 each; third gets 20.
      expect(run(100n, [9, 9, 1], split)).toEqual([
        { userId: u(1), placement: 1, payout: 40n },
        { userId: u(2), placement: 1, payout: 40n },
        { userId: u(3), placement: 3, payout: 20n },
      ]);
      // 101: the leftover unit lands on first place's prize (51 + 30 = 81), then the odd unit goes to the lower userId.
      expect(byUser(run(101n, [9, 9, 1], split))).toEqual({ [u(1)]: 41n, [u(2)]: 40n, [u(3)]: 20n });
      // Three-way tie for first over the whole table.
      expect(byUser(run(100n, [9, 9, 9], split))).toEqual({ [u(1)]: 34n, [u(2)]: 33n, [u(3)]: 33n });
    });

    it('placements use competition ranking: 1, 2, 2, 4', () => {
      expect(placements(run(100n, [9, 5, 5, 1], split))).toEqual({ [u(1)]: 1, [u(2)]: 2, [u(3)]: 2, [u(4)]: 4 });
    });

    it('higher_seed_wins breaks a tie in favour of the lower seed number; unseeded lose; equal seeds share', () => {
      const seeds = [{ seed: 2 }, { seed: 1 }, {}];
      expect(run(100n, [9, 9, 9], split, 'higher_seed_wins', seeds)).toEqual([
        { userId: u(2), placement: 1, payout: 50n },
        { userId: u(1), placement: 2, payout: 30n },
        { userId: u(3), placement: 3, payout: 20n },
      ]);
      expect(placements(run(100n, [9, 9, 9], split, 'higher_seed_wins', [{ seed: 1 }, { seed: 1 }, { seed: 1 }]))).toEqual({ [u(1)]: 1, [u(2)]: 1, [u(3)]: 1 });
    });

    it('earliest_submission_wins breaks a tie in favour of the earlier counting score; missing loses; equal share', () => {
      const times = [{ submittedAt: '2026-09-17T10:00:00.000Z' }, { submittedAt: '2026-09-17T09:59:59.000Z' }, { submittedAt: null }];
      expect(placements(run(100n, [9, 9, 9], split, 'earliest_submission_wins', times))).toEqual({ [u(2)]: 1, [u(1)]: 2, [u(3)]: 3 });
      const same = [{ submittedAt: '2026-09-17T10:00:00Z' }, { submittedAt: '2026-09-17T10:00:00.000+00:00' }];
      expect(placements(run(100n, [9, 9], split, 'earliest_submission_wins', same))).toEqual({ [u(1)]: 1, [u(2)]: 1 });
    });

    it('the tie-break key is ignored when scores differ', () => {
      expect(placements(run(100n, [1, 9], split, 'higher_seed_wins', [{ seed: 1 }, { seed: 2 }]))).toEqual({ [u(2)]: 1, [u(1)]: 2 });
    });
  });

  describe('refusals', () => {
    const wta: PrizeStructure = { type: 'winner_take_all' };
    const base: SettleInput = { asset: 'POINTS', escrowTotal: 10n, entries: entries([1, 2]), prizeStructure: wta, tieBreak: 'split_evenly' };

    it('a duplicate entrant', () => {
      expect(() => settle({ ...base, entries: [...entries([1]), ...entries([2])] })).toThrow(/appears more than once/);
    });
    it('a score that is not a finite number', () => {
      expect(() => settle({ ...base, entries: [{ userId: u(1), score: Number.NaN }] })).toThrow(/finite number or null/);
      expect(() => settle({ ...base, entries: [{ userId: u(1), score: Number.POSITIVE_INFINITY }] })).toThrow(/finite number or null/);
    });
    it('a negative or non-bigint pool', () => {
      expect(() => settle({ ...base, escrowTotal: -1n })).toThrow(/non-negative bigint/);
      expect(() => settle({ ...base, escrowTotal: 10 as unknown as bigint })).toThrow(/non-negative bigint/);
    });
    it('a prize structure the schema rejects, whatever the caller claims it is', () => {
      const bad = [
        { type: 'percentage_split', percentages: [50, 30] },
        { type: 'percentage_split', percentages: [30, 70] },
        { type: 'percentage_split', percentages: [50.5, 49.5] },
        { type: 'placement_table', placements: [{ placement: 2, amount: '1' }] },
        { type: 'placement_table', placements: [{ placement: 1, amount: '1' }, { placement: 2, percent: 1 }] },
        { type: 'placement_table', placements: [{ placement: 1, amount: '0' }] },
        { type: 'placement_table', placements: [{ placement: 1, amount: '1.5' }] },
        { type: 'top_n_equal', n: 0 },
        { type: 'guaranteed_minimum', minimums: ['1', '2'], percentages: [100] },
        { type: 'winner_take_all', participationFloor: '-1' },
        { type: 'winner_take_all', extra: true },
        { type: 'lottery' },
      ];
      for (const structure of bad) {
        expect(() => settle({ ...base, prizeStructure: structure as unknown as PrizeStructure }), JSON.stringify(structure)).toThrow(/Invalid prize structure/);
      }
    });
    it('an invalid submittedAt', () => {
      expect(() => settle({ ...base, entries: [{ userId: u(1), score: 1, submittedAt: 'yesterday' }] })).toThrow(/ISO 8601/);
    });
  });
});

describe('payoutHash', () => {
  const payouts: Payout[] = [
    { userId: u(2), placement: 2, payout: 30n },
    { userId: u(1), placement: 1, payout: 70n },
  ];

  it('is sha256 over the documented canonical form', () => {
    expect(canonicalPayouts(payouts)).toBe('{"v":1,"payouts":[[1,"usr_001","70"],[2,"usr_002","30"]]}');
    expect(payoutHash(payouts)).toMatch(/^[0-9a-f]{64}$/);
    expect(payoutHash(payouts)).toBe(payoutHash([...payouts].reverse()));
  });

  it('changes when any payout, placement or entrant changes', () => {
    const base = payoutHash(payouts);
    const [second, first] = payouts;
    if (second === undefined || first === undefined) throw new Error('fixture');
    expect(payoutHash([{ ...second, payout: 31n }, first])).not.toBe(base);
    expect(payoutHash([{ ...second, placement: 3 }, first])).not.toBe(base);
    expect(payoutHash([{ ...second, userId: u(3) }, first])).not.toBe(base);
    expect(payoutHash([])).not.toBe(base);
  });
});

describe('the arithmetic helpers', () => {
  it('evenSplit hands leftovers to the first shares', () => {
    expect(evenSplit(100n, 3)).toEqual([34n, 33n, 33n]);
    expect(evenSplit(5n, 3)).toEqual([2n, 2n, 1n]);
    expect(evenSplit(0n, 2)).toEqual([0n, 0n]);
    expect(evenSplit(7n, 0)).toEqual([]);
  });
  it('proportional floors every share and never reaches a zero-weight slot with a leftover', () => {
    expect(proportional(101n, [50n, 30n, 20n])).toEqual([51n, 30n, 20n]);
    expect(proportional(10n, [1n, 1n, 1n, 0n, 0n])).toEqual([4n, 3n, 3n, 0n, 0n]);
    expect(proportional(10n, [0n, 0n])).toEqual([10n, 0n]);
    expect(proportional(10n, [])).toEqual([]);
  });
});

// ---- properties ----------------------------------------------------------------------

const amount = fc.bigInt({ min: 0n, max: 1_000_000_000_000n }).map((n) => n.toString());

/** Non-increasing integer percentages summing to exactly 100. */
const percentages = fc
  .array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 })
  .map((weights) => {
    const sorted = [...weights].sort((a, b) => b - a);
    const total = sorted.reduce((sum, w) => sum + w, 0);
    const shares = sorted.map((w) => Math.floor((100 * w) / total));
    shares[0] = (shares[0] ?? 0) + (100 - shares.reduce((sum, s) => sum + s, 0));
    return shares;
  });

const nonIncreasingAmounts = fc
  .array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 6 })
  .map((values) => [...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)))
  .filter((values) => (values[0] ?? 0n) > 0n);

const floor = fc.option(amount, { nil: undefined });

const structure: fc.Arbitrary<PrizeStructure> = fc.oneof(
  floor.map((participationFloor) => ({ type: 'winner_take_all' as const, ...(participationFloor === undefined ? {} : { participationFloor }) })),
  fc.tuple(percentages, floor).map(([p, participationFloor]) => ({ type: 'percentage_split' as const, percentages: p, ...(participationFloor === undefined ? {} : { participationFloor }) })),
  fc.tuple(fc.integer({ min: 1, max: 12 }), floor).map(([n, participationFloor]) => ({ type: 'top_n_equal' as const, n, ...(participationFloor === undefined ? {} : { participationFloor }) })),
  fc.tuple(nonIncreasingAmounts, floor).map(([amounts, participationFloor]) => ({
    type: 'placement_table' as const,
    placements: amounts.map((each, index) => ({ placement: index + 1, amount: each.toString() })),
    ...(participationFloor === undefined ? {} : { participationFloor }),
  })),
  fc.tuple(percentages, floor).map(([p, participationFloor]) => ({
    type: 'placement_table' as const,
    placements: p.map((percent, index) => ({ placement: index + 1, percent })),
    ...(participationFloor === undefined ? {} : { participationFloor }),
  })),
  fc.tuple(nonIncreasingAmounts, percentages, floor).map(([minimums, p, participationFloor]) => ({
    type: 'guaranteed_minimum' as const,
    minimums: minimums.map((each) => each.toString()),
    percentages: p,
    ...(participationFloor === undefined ? {} : { participationFloor }),
  })),
);

/** Scores from a small range so ties are common; a fifth of them unscored. */
const score = fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 0, max: 6 }).map((n) => n as number | null) }, { weight: 1, arbitrary: fc.constant(null) });

const entry = fc.record({
  score,
  seed: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
  submittedAt: fc.option(fc.integer({ min: 0, max: 4 }).map((n) => new Date(1_758_000_000_000 + n * 1000).toISOString()), { nil: null }),
});

const contest = fc
  .tuple(fc.array(entry, { minLength: 0, maxLength: 12 }), fc.bigInt({ min: 0n, max: 10_000_000n }), structure, fc.constantFrom(...TIE_BREAK_RULES))
  .map(([drawn, pool, prizeStructure, tieBreak]): SettleInput => ({
    asset: 'POINTS',
    escrowTotal: drawn.length === 0 ? 0n : pool,
    entries: drawn.map((each, index) => ({ userId: u(index + 1), ...each })),
    prizeStructure,
    tieBreak,
  }));

const RUNS = 2000;

describe('settle: properties over generated contests', () => {
  it('conservation: the payouts sum to the escrow exactly, always', () => {
    fc.assert(
      fc.property(contest, (input) => {
        const payouts = settle(input);
        expect(payouts.reduce((sum, p) => sum + p.payout, 0n)).toBe(input.escrowTotal);
        expect(payouts).toHaveLength(input.entries.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('non-negativity: no payout is below zero and every entrant is paid exactly once', () => {
    fc.assert(
      fc.property(contest, (input) => {
        const payouts = settle(input);
        for (const p of payouts) expect(p.payout).toBeGreaterThanOrEqual(0n);
        expect(new Set(payouts.map((p) => p.userId)).size).toBe(input.entries.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('placement monotonicity: a strictly higher score never places lower or receives strictly less', () => {
    fc.assert(
      fc.property(contest, (input) => {
        const payouts = settle(input);
        const paid = new Map(payouts.map((p) => [p.userId, p]));
        for (const a of input.entries) {
          for (const b of input.entries) {
            if (a.score === null || b.score === null || a.score <= b.score) continue;
            const pa = paid.get(a.userId);
            const pb = paid.get(b.userId);
            expect(pa?.placement ?? 0).toBeLessThan(pb?.placement ?? 0);
            expect(pa?.payout ?? 0n).toBeGreaterThanOrEqual(pb?.payout ?? 0n);
          }
          if (a.score !== null) {
            for (const unscored of input.entries.filter((e) => e.score === null)) {
              expect(paid.get(a.userId)?.placement ?? 0).toBeLessThan(paid.get(unscored.userId)?.placement ?? 0);
            }
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('placements are competition ranking: 1, then each group at 1 + the number ranked above it, tied groups identical', () => {
    fc.assert(
      fc.property(contest, (input) => {
        const payouts = settle(input);
        const sorted = [...payouts].sort((a, b) => a.placement - b.placement || (a.userId < b.userId ? -1 : 1));
        expect(sorted).toEqual(payouts);
        let seen = 0;
        let last = 0;
        for (const p of sorted) {
          if (p.placement !== last) {
            expect(p.placement).toBe(seen + 1);
            last = p.placement;
          }
          seen += 1;
        }
        // Tied placements (under split_evenly, same score) receive amounts within one unit of each other.
        for (const group of new Set(sorted.map((p) => p.placement))) {
          const amounts = sorted.filter((p) => p.placement === group).map((p) => p.payout);
          const max = amounts.reduce((m, a) => (a > m ? a : m), 0n);
          const min = amounts.reduce((m, a) => (a < m ? a : m), max);
          expect(max - min).toBeLessThanOrEqual(1n);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('determinism: any permutation of the entries gives the same payouts, byte for byte, and the same hash', () => {
    fc.assert(
      fc.property(
        contest.chain((input) => fc.tuple(fc.constant(input), fc.shuffledSubarray([...input.entries], { minLength: input.entries.length, maxLength: input.entries.length }))),
        ([input, shuffled]) => {
          const a = settle(input);
          const b = settle({ ...input, entries: shuffled });
          expect(JSON.stringify(b, bigintSafe)).toBe(JSON.stringify(a, bigintSafe));
          expect(payoutHash(b)).toBe(payoutHash(a));
          expect(settle(input)).toEqual(a);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('remainder allocation: under an equal split the leftover units go one each to the best placements, then by userId', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.bigInt({ min: 0n, max: 100_000n }), (n, pool) => {
        // n distinct scores, so every entrant holds their own placement and the top n share evenly.
        const input: SettleInput = {
          asset: 'POINTS',
          escrowTotal: pool,
          entries: Array.from({ length: n }, (_, i) => ({ userId: u(i + 1), score: n - i })),
          prizeStructure: { type: 'top_n_equal', n },
          tieBreak: 'split_evenly',
        };
        const payouts = settle(input);
        const base = pool / BigInt(n);
        const leftover = Number(pool % BigInt(n));
        payouts.forEach((p, index) => {
          expect(p.placement).toBe(index + 1);
          expect(p.payout).toBe(index < leftover ? base + 1n : base);
        });
      }),
      { numRuns: 500 },
    );
  });

  it('the floor-then-remainder rule: no share is ever more than one unit above a lower placement of equal weight', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.bigInt({ min: 0n, max: 100_000n }), fc.constantFrom(...TIE_BREAK_RULES), (n, pool, tieBreak) => {
        // Everyone tied: the whole pool shared evenly with the rounding rule, whatever the tie rule.
        const input: SettleInput = {
          asset: 'POINTS',
          escrowTotal: pool,
          entries: Array.from({ length: n }, (_, i) => ({ userId: u(i + 1), score: 1 })),
          prizeStructure: { type: 'winner_take_all' },
          tieBreak,
        };
        const payouts = settle(input);
        expect(payouts.map((p) => p.payout)).toEqual(evenSplit(pool, n));
        expect(payouts.every((p) => p.placement === 1)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
