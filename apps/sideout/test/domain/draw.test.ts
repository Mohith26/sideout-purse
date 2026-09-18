import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertDrawableFormat,
  bracketSizeFor,
  drawBracket,
  drawPools,
  drawSingleElimination,
  DrawError,
  orderEntries,
  partitionIntoPools,
  rankForBracket,
  roundRobinRounds,
  seedPlacement,
  type DrawTeam,
} from '../../src/domain/draw';
import { createRng } from '../../src/domain/rng';
import { computeStandings } from '../../src/domain/standings';

const team = (n: number, seed: number | null = null): DrawTeam => ({ id: `tm_${String(n).padStart(3, '0')}`, seed });

/** `n` teams, the first `seeded` of them carrying entry seeds 1..seeded. */
const field = (n: number, seeded = 0): DrawTeam[] => Array.from({ length: n }, (_, i) => team(i + 1, i < seeded ? i + 1 : null));

const arbField = fc
  .record({ n: fc.integer({ min: 2, max: 64 }), seededFraction: fc.double({ min: 0, max: 1, noNaN: true }) })
  .map(({ n, seededFraction }) => field(n, Math.floor(n * seededFraction)));

describe('orderEntries', () => {
  it('places seeded teams first by seed, then the unseeded in rng order', () => {
    const teams = [team(1), team(2, 2), team(3), team(4, 1)];
    const ordered = orderEntries(teams, createRng(7));
    expect(ordered.slice(0, 2).map((t) => t.seed)).toEqual([1, 2]);
    expect(new Set(ordered.slice(2).map((t) => t.id))).toEqual(new Set(['tm_001', 'tm_003']));
  });

  it('is deterministic for one rng seed and never changes an entry seed', () => {
    fc.assert(
      fc.property(arbField, fc.integer({ min: 0, max: 0xffff }), (teams, seed) => {
        const first = orderEntries(teams, createRng(seed));
        const second = orderEntries(teams, createRng(seed));
        expect(first).toEqual(second);
        for (const t of teams) expect(first.find((x) => x.id === t.id)?.seed).toBe(t.seed);
      }),
    );
  });

  it('refuses duplicate teams and duplicate seeds', () => {
    expect(() => orderEntries([team(1), team(1)], createRng(1))).toThrow(DrawError);
    expect(() => orderEntries([team(1, 1), team(2, 1)], createRng(1))).toThrow(/assigned twice/);
    expect(() => orderEntries([team(1, 0)], createRng(1))).toThrow(/positive integer/);
  });
});

describe('partitionIntoPools', () => {
  it('snake-seeds: 1..k across, then k..1 back', () => {
    const pools = partitionIntoPools(field(10, 10), 4);
    expect(pools).toEqual([
      ['tm_001', 'tm_006', 'tm_007'],
      ['tm_002', 'tm_005', 'tm_008'],
      ['tm_003', 'tm_004', 'tm_009', 'tm_010'],
    ]);
  });

  it('every team lands in exactly one pool, sizes differ by at most one, none exceeds the pool size, none is alone', () => {
    fc.assert(
      fc.property(arbField, fc.integer({ min: 2, max: 8 }), (teams, poolSize) => {
        const entries = orderEntries(teams, createRng(1));
        if (poolSize === 2 && teams.length % 2 === 1) {
          expect(() => partitionIntoPools(entries, poolSize)).toThrow(DrawError);
          return;
        }
        const pools = partitionIntoPools(entries, poolSize);
        const all = pools.flat();
        expect(all.length).toBe(teams.length);
        expect(new Set(all).size).toBe(teams.length);
        const sizes = pools.map((p) => p.length);
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(poolSize);
        expect(pools.length).toBe(Math.ceil(teams.length / poolSize));
      }),
    );
  });

  it('refuses a pool size under two, a field under two, and a configuration that leaves a team alone', () => {
    expect(() => partitionIntoPools(field(4), 1)).toThrow(/at least 2/);
    expect(() => partitionIntoPools(field(1), 4)).toThrow(/at least two teams/);
    for (const n of [3, 5, 7, 9]) {
      try {
        partitionIntoPools(field(n), 2);
        expect.unreachable(`a pool size of 2 with ${n} teams must be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(DrawError);
        expect((error as DrawError).code).toBe('invalid_pool_size');
        expect((error as DrawError).message).toBe(`A pool size of 2 leaves a pool with one team for a field of ${n}; a pool size of 3 works.`);
      }
      expect(partitionIntoPools(field(n), 3).every((pool) => pool.length >= 2)).toBe(true);
    }
    expect(partitionIntoPools(field(4), 2)).toEqual([['tm_001', 'tm_004'], ['tm_002', 'tm_003']]);
  });
});

describe('roundRobinRounds', () => {
  it('every pair meets exactly once and no team plays twice in a round', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (n) => {
        const ids = field(n).map((t) => t.id);
        const rounds = roundRobinRounds(ids);
        const seen = new Set<string>();
        for (const round of rounds) {
          const inRound = new Set<string>();
          for (const [a, b] of round) {
            expect(a).not.toBe(b);
            expect(inRound.has(a)).toBe(false);
            expect(inRound.has(b)).toBe(false);
            inRound.add(a);
            inRound.add(b);
            const key = [a, b].sort().join('|');
            expect(seen.has(key)).toBe(false);
            seen.add(key);
          }
        }
        expect(seen.size).toBe((n * (n - 1)) / 2);
        expect(rounds.length).toBe(n % 2 === 0 ? n - 1 : n);
      }),
    );
  });
});

describe('drawPools', () => {
  it('produces a complete pool stage with courts and court queues', () => {
    const draw = drawPools({ teams: field(24, 8), poolSize: 4, courts: 6, bestOf: 1, rng: createRng(42) });
    expect(draw.pools).toHaveLength(6);
    expect(draw.pools.map((p) => p.label)).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool D', 'Pool E', 'Pool F']);
    expect(draw.pools.map((p) => p.courtLabel)).toEqual(['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6']);
    expect(draw.matches).toHaveLength(6 * 6);
    // Entry seeds 1..6 head the six pools; 7 and 8 snake back into pools F and E.
    expect(draw.pools.map((p) => p.teamIds[0])).toEqual(['tm_001', 'tm_002', 'tm_003', 'tm_004', 'tm_005', 'tm_006']);
    expect(draw.pools[5]?.teamIds[1]).toBe('tm_007');
    expect(draw.pools[4]?.teamIds[1]).toBe('tm_008');
    // Each court runs its pool's six matches in sequence; round 1 before round 2.
    for (const pool of draw.pools) {
      const slots = draw.matches.filter((m) => m.poolSequence === pool.sequence).sort((x, y) => x.courtSlot - y.courtSlot);
      expect(slots.map((m) => m.courtSlot)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(slots.map((m) => m.round)).toEqual([1, 1, 2, 2, 3, 3]);
    }
  });

  it('shares courts when there are fewer courts than pools, without double-booking a slot', () => {
    const draw = drawPools({ teams: field(16), poolSize: 4, courts: 2, bestOf: 1, rng: createRng(3) });
    const byCourt = new Map<string, number[]>();
    for (const m of draw.matches) byCourt.set(m.courtLabel, [...(byCourt.get(m.courtLabel) ?? []), m.courtSlot]);
    expect([...byCourt.keys()].sort()).toEqual(['Court 1', 'Court 2']);
    for (const slots of byCourt.values()) expect([...slots].sort((a, b) => a - b)).toEqual(slots.map((_, i) => i));
  });

  it('is deterministic for one rng seed and keeps seeded teams in place across rng seeds', () => {
    fc.assert(
      fc.property(arbField, fc.integer({ min: 2, max: 8 }), fc.integer({ min: 0, max: 9999 }), (teams, poolSize, seed) => {
        fc.pre(!(poolSize === 2 && teams.length % 2 === 1));
        const a = drawPools({ teams, poolSize, courts: 4, bestOf: 1, rng: createRng(seed) });
        const b = drawPools({ teams, poolSize, courts: 4, bestOf: 1, rng: createRng(seed) });
        expect(a).toEqual(b);
        const c = drawPools({ teams, poolSize, courts: 4, bestOf: 1, rng: createRng(seed + 1) });
        const seededCount = teams.filter((t) => t.seed !== null).length;
        const placement = (draw: typeof a) =>
          draw.pools.flatMap((p) => p.teamIds.map((id, position) => ({ id, pool: p.sequence, position })));
        const seededA = placement(a).filter((x) => teams.some((t) => t.id === x.id && t.seed !== null));
        const seededC = placement(c).filter((x) => teams.some((t) => t.id === x.id && t.seed !== null));
        expect(seededA).toHaveLength(seededCount);
        expect(seededC).toEqual(seededA);
      }),
    );
  });
});

describe('seedPlacement and bracketSizeFor', () => {
  it('builds the standard placement recursively', () => {
    expect(seedPlacement(1)).toEqual([1]);
    expect(seedPlacement(2)).toEqual([1, 2]);
    expect(seedPlacement(4)).toEqual([1, 4, 2, 3]);
    expect(seedPlacement(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedPlacement(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
    expect(() => seedPlacement(6)).toThrow(/power of two/);
  });

  it('every round-1 pairing sums to size + 1', () => {
    for (const size of [2, 4, 8, 16, 32, 64]) {
      const order = seedPlacement(size);
      for (let i = 0; i < size; i += 2) expect((order[i] ?? 0) + (order[i + 1] ?? 0)).toBe(size + 1);
    }
  });

  it('picks the smallest power of two that fits', () => {
    expect(bracketSizeFor(2)).toBe(2);
    expect(bracketSizeFor(3)).toBe(4);
    expect(bracketSizeFor(15)).toBe(16);
    expect(bracketSizeFor(16)).toBe(16);
    expect(bracketSizeFor(17)).toBe(32);
    expect(() => bracketSizeFor(1)).toThrow(/at least two/);
    expect(() => bracketSizeFor(65)).toThrow(/at most 64/);
  });
});

describe('drawBracket', () => {
  const seedsFor = (n: number) => Array.from({ length: n }, (_, i) => ({ teamId: `tm_${String(i + 1).padStart(3, '0')}`, seed: i + 1 }));

  it('slots are consistent with seeds, byes are only in round 1 and go to the top seeds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 64 }), fc.integer({ min: 1, max: 8 }), (n, courts) => {
        const draw = drawBracket({ seeds: seedsFor(n), courts, bestOf: 3 });
        const size = bracketSizeFor(n);
        expect(draw.size).toBe(size);
        expect(draw.matches).toHaveLength(size - 1);
        expect(draw.rounds).toBe(Math.log2(size));

        const round1 = draw.matches.filter((m) => m.round === 1);
        const byes = draw.matches.filter((m) => m.isBye);
        expect(byes.every((m) => m.round === 1)).toBe(true);
        expect(byes).toHaveLength(size - n);
        // The seeds that get a bye are exactly the top (size - n) seeds.
        expect(byes.map((m) => m.teamASeed).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
          Array.from({ length: size - n }, (_, i) => i + 1),
        );
        // Every played round-1 match pairs seeds summing to size + 1, both present.
        for (const m of round1.filter((x) => !x.isBye)) {
          expect(m.teamAId).not.toBeNull();
          expect(m.teamBId).not.toBeNull();
          expect((m.teamASeed ?? 0) + (m.teamBSeed ?? 0)).toBe(size + 1);
        }
        // Every team appears exactly once in round 1.
        const round1Teams = round1.flatMap((m) => [m.teamAId, m.teamBId]).filter((x): x is string => x !== null);
        expect(new Set(round1Teams).size).toBe(n);
        // Links: each non-final match feeds exactly one next match; each next match is fed by two, in distinct slots.
        const feeders = new Map<number, string[]>();
        for (const m of draw.matches) {
          if (m.round === draw.rounds) {
            expect(m.nextPosition).toBeNull();
            expect(m.nextSlot).toBeNull();
            continue;
          }
          expect(m.nextPosition).not.toBeNull();
          const next = draw.matches.find((x) => x.position === m.nextPosition);
          expect(next?.round).toBe(m.round + 1);
          feeders.set(m.nextPosition ?? 0, [...(feeders.get(m.nextPosition ?? 0) ?? []), m.nextSlot ?? '']);
        }
        for (const slots of feeders.values()) expect([...slots].sort()).toEqual(['a', 'b']);
        // A bye's team is already sitting in its next match's slot.
        for (const bye of byes) {
          const next = draw.matches.find((x) => x.position === bye.nextPosition);
          if (next === undefined) continue; // a 2-team bracket has no next
          expect(bye.nextSlot === 'a' ? next.teamAId : next.teamBId).toBe(bye.teamAId);
        }
        // Positions are unique and breadth-first.
        expect(draw.matches.map((m) => m.position)).toEqual(draw.matches.map((_, i) => i + 1));
        // Court slots never collide on one court.
        const byCourt = new Map<string, number[]>();
        for (const m of draw.matches.filter((x) => !x.isBye)) {
          byCourt.set(m.courtLabel, [...(byCourt.get(m.courtLabel) ?? []), m.courtSlot]);
        }
        for (const slots of byCourt.values()) expect(new Set(slots).size).toBe(slots.length);
        // A match is scheduled strictly after every played match that feeds it, whatever the court.
        for (const m of draw.matches.filter((x) => !x.isBye && x.nextPosition !== null)) {
          const next = draw.matches.find((x) => x.position === m.nextPosition);
          expect(next?.courtSlot).toBeGreaterThan(m.courtSlot);
        }
      }),
    );
  });

  it('never schedules a later round alongside the round that feeds it', () => {
    const twelveOnFour = drawBracket({ seeds: seedsFor(12), courts: 4, bestOf: 3 });
    const lastOf = (round: number) => Math.max(...twelveOnFour.matches.filter((m) => m.round === round && !m.isBye).map((m) => m.courtSlot));
    const firstOf = (round: number) => Math.min(...twelveOnFour.matches.filter((m) => m.round === round && !m.isBye).map((m) => m.courtSlot));
    expect(firstOf(2)).toBeGreaterThan(lastOf(1));
    expect(firstOf(3)).toBeGreaterThan(lastOf(2));
    expect(firstOf(4)).toBeGreaterThan(lastOf(3));

    const eightOnThree = drawBracket({ seeds: seedsFor(8), courts: 3, bestOf: 3 });
    const round1 = eightOnThree.matches.filter((m) => m.round === 1);
    expect(round1.map((m) => [m.courtLabel, m.courtSlot])).toEqual([
      ['Court 1', 0],
      ['Court 2', 0],
      ['Court 3', 0],
      ['Court 1', 1],
    ]);
    expect(eightOnThree.matches.filter((m) => m.round === 2).map((m) => [m.courtLabel, m.courtSlot])).toEqual([
      ['Court 1', 2],
      ['Court 2', 2],
    ]);
    expect(eightOnThree.matches.filter((m) => m.round === 3).map((m) => [m.courtLabel, m.courtSlot])).toEqual([['Court 1', 3]]);
  });

  it('deals the played matches of a round across every court, skipping byes', () => {
    // Six teams on two courts: seeds 1 and 2 have byes at indices 0 and 2, so the two real
    // round-1 matches take one court each and the quarter-final round starts right after.
    const sixOnTwo = drawBracket({ seeds: seedsFor(6), courts: 2, bestOf: 3 });
    const round1 = sixOnTwo.matches.filter((m) => m.round === 1 && !m.isBye);
    expect(round1.map((m) => [m.courtLabel, m.courtSlot])).toEqual([
      ['Court 1', 0],
      ['Court 2', 0],
    ]);
    expect(sixOnTwo.matches.filter((m) => m.round === 2).map((m) => [m.courtLabel, m.courtSlot])).toEqual([
      ['Court 1', 1],
      ['Court 2', 1],
    ]);
    expect(sixOnTwo.matches.filter((m) => m.round === 3).map((m) => [m.courtLabel, m.courtSlot])).toEqual([['Court 1', 2]]);

    fc.assert(
      fc.property(fc.integer({ min: 2, max: 64 }), fc.integer({ min: 1, max: 8 }), (n, courts) => {
        const draw = drawBracket({ seeds: seedsFor(n), courts, bestOf: 3 });
        for (let round = 1; round <= draw.rounds; round += 1) {
          const played = draw.matches.filter((m) => m.round === round && !m.isBye);
          const used = new Set(played.map((m) => m.courtLabel));
          expect(used.size).toBe(Math.min(courts, played.length));
        }
      }),
    );
  });

  it('keeps seeds 1 and 2 in opposite halves', () => {
    for (const n of [8, 12, 16, 24, 32]) {
      const draw = drawBracket({ seeds: seedsFor(n), courts: 4, bestOf: 3 });
      const half = draw.matches.filter((m) => m.round === 1).length / 2;
      const of = (seed: number) => draw.matches.find((m) => m.round === 1 && (m.teamASeed === seed || m.teamBSeed === seed));
      expect((of(1)?.indexInRound ?? 0) < half).toBe(true);
      expect((of(2)?.indexInRound ?? 0) >= half).toBe(true);
    }
  });

  it('refuses gaps in the seed list', () => {
    expect(() => drawBracket({ seeds: [{ teamId: 'x', seed: 1 }, { teamId: 'y', seed: 3 }], courts: 1, bestOf: 3 })).toThrow(/no gaps/);
  });

  it('draws single elimination straight from entry seeds', () => {
    const draw = drawSingleElimination({ teams: field(6, 3), courts: 2, bestOf: 3, rng: createRng(9) });
    expect(draw.size).toBe(8);
    const byes = draw.matches.filter((m) => m.isBye);
    expect(byes.map((m) => m.teamAId).sort()).toEqual(['tm_001', 'tm_002']);
  });
});

describe('rankForBracket', () => {
  it('takes the top N per pool then the best remaining, seeding winners before runners-up', () => {
    const ids = (pool: string) => ['w', 'x', 'y', 'z'].map((s) => `${pool}-${s}`);
    const perfect = (pool: string) => {
      const [w, x, y, z] = ids(pool) as [string, string, string, string];
      // w beats everyone, x beats y and z, y beats z: a clean 3-2-1-0.
      return computeStandings(ids(pool), [
        { teamAId: w, teamBId: x, winnerTeamId: w, sets: [{ teamAPoints: 21, teamBPoints: 15 }] },
        { teamAId: w, teamBId: y, winnerTeamId: w, sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
        { teamAId: w, teamBId: z, winnerTeamId: w, sets: [{ teamAPoints: 21, teamBPoints: 5 }] },
        { teamAId: x, teamBId: y, winnerTeamId: x, sets: [{ teamAPoints: 21, teamBPoints: 18 }] },
        { teamAId: x, teamBId: z, winnerTeamId: x, sets: [{ teamAPoints: 21, teamBPoints: 12 }] },
        { teamAId: y, teamBId: z, winnerTeamId: y, sets: [{ teamAPoints: 21, teamBPoints: 19 }] },
      ]);
    };
    const pools = [
      { sequence: 0, standings: perfect('a') },
      { sequence: 1, standings: perfect('b') },
      { sequence: 2, standings: perfect('c') },
    ];
    const seeds = rankForBracket(pools, { perPool: 2, wildcards: 1 });
    expect(seeds).toHaveLength(7);
    expect(seeds.slice(0, 3).map((s) => s.teamId)).toEqual(['a-w', 'b-w', 'c-w']);
    expect(seeds.slice(3, 6).map((s) => s.teamId).sort()).toEqual(['a-x', 'b-x', 'c-x']);
    // The best third-placed team is the wildcard; a-y (+27 - 18 = 21-18 lost 10-21 lost 18-21... ) they are all
    // identical in wins; the differential picks it.
    expect(seeds[6]?.teamId).toMatch(/-y$/);
    expect(seeds.map((s) => s.seed)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('refuses more wildcards than teams remain', () => {
    const standings = computeStandings(['p', 'q'], [{ teamAId: 'p', teamBId: 'q', winnerTeamId: 'p', sets: [] }]);
    expect(() => rankForBracket([{ sequence: 0, standings }], { perPool: 1, wildcards: 2 })).toThrow(/wildcard/);
  });
});

describe('assertDrawableFormat', () => {
  it('refuses double elimination with a specific error and accepts the other three', () => {
    expect(() => assertDrawableFormat('double_elim')).toThrow(DrawError);
    try {
      assertDrawableFormat('double_elim');
    } catch (error) {
      expect(error).toBeInstanceOf(DrawError);
      expect((error as DrawError).code).toBe('double_elim_unsupported');
    }
    for (const format of ['pool_to_bracket', 'single_elim', 'round_robin'] as const) {
      expect(() => assertDrawableFormat(format)).not.toThrow();
    }
  });
});
