import type { BestOf, MatchSlot, TournamentFormat } from '../db/schema';
import type { AdvancementRule } from './draw-config';
import type { Rng } from './rng';
import { compareAcrossPools, type StandingRow } from './standings';

/**
 * Draw generation. Pure and deterministic: the only randomness is the injected `Rng`,
 * and there is no clock, database or network. The services persist what comes out; the
 * seed script uses the same functions so seeded draws and drawn draws cannot disagree.
 *
 * Three formats are drawn here. `double_elim` stays in the tournament enum and is refused
 * with `DrawError('double_elim_unsupported')` (docs/decisions.md records the follow-up).
 */

export type DrawErrorCode =
  | 'too_few_teams'
  | 'too_many_teams'
  | 'duplicate_team'
  | 'invalid_pool_size'
  | 'double_elim_unsupported'
  | 'advancement_exceeds_field'
  | 'invalid_seed_list';

export class DrawError extends Error {
  override readonly name = 'DrawError';
  constructor(
    readonly code: DrawErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The formats the engine draws. `double_elim` is refused; see `assertDrawableFormat`. */
export const DRAWABLE_FORMATS = ['pool_to_bracket', 'single_elim', 'round_robin'] as const;
export type DrawableFormat = (typeof DRAWABLE_FORMATS)[number];

export function assertDrawableFormat(format: TournamentFormat): asserts format is DrawableFormat {
  if (format === 'double_elim') {
    throw new DrawError(
      'double_elim_unsupported',
      'Double elimination is not drawn yet: the losers bracket and its crossover rounds are a follow-up (docs/decisions.md).',
    );
  }
}

/** A team as the draw sees it: its id and the organizer's entry seed, if any. */
export type DrawTeam = { id: string; seed: number | null };

/** Bracket sizes the engine supports (a 64-team single elimination is the largest). */
export const MAX_BRACKET_SIZE = 64;

function courtLabel(index: number): string {
  return `Court ${index + 1}`;
}

function poolLabel(sequence: number): string {
  return `Pool ${String.fromCharCode(65 + sequence)}`;
}

function assertDistinct(teams: readonly DrawTeam[]): void {
  const ids = new Set<string>();
  for (const team of teams) {
    if (ids.has(team.id)) throw new DrawError('duplicate_team', `Team ${team.id} appears twice in the field.`);
    ids.add(team.id);
  }
  const seeds = new Set<number>();
  for (const team of teams) {
    if (team.seed === null) continue;
    if (!Number.isInteger(team.seed) || team.seed < 1) {
      throw new DrawError('invalid_seed_list', `Seed ${team.seed} for team ${team.id} is not a positive integer.`);
    }
    if (seeds.has(team.seed)) throw new DrawError('invalid_seed_list', `Seed ${team.seed} is assigned twice.`);
    seeds.add(team.seed);
  }
}

/**
 * Entry order: seeded teams by entry seed ascending, then unseeded teams in an order the
 * `Rng` decides. The result is the "seed line" both the pool draw and the single
 * elimination draw place teams from.
 */
export function orderEntries(teams: readonly DrawTeam[], rng: Rng): DrawTeam[] {
  assertDistinct(teams);
  const seeded = teams.filter((t) => t.seed !== null).sort((x, y) => (x.seed ?? 0) - (y.seed ?? 0));
  const unseeded = rng.shuffle(teams.filter((t) => t.seed === null));
  return [...seeded, ...unseeded];
}

// ---- Pools ------------------------------------------------------------------------------

export type PoolDrawPool = {
  sequence: number;
  label: string;
  courtLabel: string;
  /** Team ids in snake-seeding position order (position = index + 1). */
  teamIds: string[];
};

export type PoolDrawMatch = {
  poolSequence: number;
  round: number;
  /** Zero-based order of the match within its pool's round. */
  sequenceInRound: number;
  teamAId: string;
  teamBId: string;
  courtLabel: string;
  /** Zero-based order of the match on its court across the whole pool stage. */
  courtSlot: number;
  bestOf: BestOf;
};

export type PoolDraw = { pools: PoolDrawPool[]; matches: PoolDrawMatch[] };

/**
 * Balanced pools by snake seeding: the seed line is dealt across the pools left to
 * right, then right to left, and so on, so pool sizes differ by at most one and the
 * strongest entries are spread apart. Pool count is the smallest that keeps every pool
 * at or under `poolSize`.
 */
export function partitionIntoPools(entries: readonly DrawTeam[], poolSize: number): string[][] {
  if (!Number.isInteger(poolSize) || poolSize < 2) {
    throw new DrawError('invalid_pool_size', `Pool size must be at least 2; got ${poolSize}.`);
  }
  if (entries.length < 2) throw new DrawError('too_few_teams', 'A pool stage needs at least two teams.');
  const poolCount = Math.ceil(entries.length / poolSize);
  const pools: string[][] = Array.from({ length: poolCount }, () => []);
  entries.forEach((team, index) => {
    const row = Math.floor(index / poolCount);
    const column = index % poolCount;
    const pool = row % 2 === 0 ? column : poolCount - 1 - column;
    pools[pool]?.push(team.id);
  });
  return pools;
}

/**
 * Round-robin schedule by the circle method: every pair meets exactly once, and no team
 * plays twice in one round. An odd field gets a rotating sit-out.
 */
export function roundRobinRounds(teamIds: readonly string[]): Array<Array<[string, string]>> {
  const ring: Array<string | null> = [...teamIds];
  if (ring.length % 2 === 1) ring.push(null);
  const n = ring.length;
  const rounds: Array<Array<[string, string]>> = [];
  for (let r = 0; r < n - 1; r += 1) {
    const round: Array<[string, string]> = [];
    for (let i = 0; i < n / 2; i += 1) {
      const home = ring[i];
      const away = ring[n - 1 - i];
      if (home === null || home === undefined || away === null || away === undefined) continue;
      // Alternate which side is "team A" so the fixed team does not always serve first.
      round.push(r % 2 === 0 ? [home, away] : [away, home]);
    }
    rounds.push(round);
    // Rotate every position but the first.
    const last = ring.pop();
    if (last !== undefined) ring.splice(1, 0, last);
  }
  return rounds;
}

export function drawPools(input: {
  teams: readonly DrawTeam[];
  poolSize: number;
  courts: number;
  bestOf: BestOf;
  rng: Rng;
}): PoolDraw {
  if (input.teams.length > MAX_BRACKET_SIZE * 2) {
    throw new DrawError('too_many_teams', `At most ${MAX_BRACKET_SIZE * 2} teams can be drawn into pools.`);
  }
  const entries = orderEntries(input.teams, input.rng);
  const partition = partitionIntoPools(entries, input.poolSize);
  const courts = Math.max(1, Math.floor(input.courts));

  const pools: PoolDrawPool[] = partition.map((teamIds, sequence) => ({
    sequence,
    label: poolLabel(sequence),
    courtLabel: courtLabel(sequence % courts),
    teamIds,
  }));

  const matches: PoolDrawMatch[] = [];
  for (const pool of pools) {
    roundRobinRounds(pool.teamIds).forEach((round, roundIndex) => {
      round.forEach(([teamAId, teamBId], sequenceInRound) => {
        matches.push({
          poolSequence: pool.sequence,
          round: roundIndex + 1,
          sequenceInRound,
          teamAId,
          teamBId,
          courtLabel: pool.courtLabel,
          courtSlot: 0,
          bestOf: input.bestOf,
        });
      });
    });
  }
  assignCourtSlots(matches);
  return { pools, matches };
}

/**
 * Order matches on each court: every pool's round 1 before any round 2, and within a
 * round by pool then by sequence. Each court is a queue; the slot is the match's place
 * in it, which the service turns into a start time.
 */
function assignCourtSlots(matches: PoolDrawMatch[]): void {
  const ordered = [...matches].sort(
    (x, y) => x.round - y.round || x.poolSequence - y.poolSequence || x.sequenceInRound - y.sequenceInRound,
  );
  const nextSlot = new Map<string, number>();
  for (const match of ordered) {
    const slot = nextSlot.get(match.courtLabel) ?? 0;
    match.courtSlot = slot;
    nextSlot.set(match.courtLabel, slot + 1);
  }
}

// ---- Brackets ---------------------------------------------------------------------------

export type BracketSeedEntry = { teamId: string; seed: number };

export type BracketDrawMatch = {
  /** One-based, breadth-first from round 1, unique within the bracket. */
  position: number;
  round: number;
  indexInRound: number;
  teamAId: string | null;
  teamBId: string | null;
  teamASeed: number | null;
  teamBSeed: number | null;
  nextPosition: number | null;
  nextSlot: MatchSlot | null;
  /** Round-1 match with one side empty: the present team advances without playing. */
  isBye: boolean;
  courtLabel: string;
  courtSlot: number;
  bestOf: BestOf;
};

export type BracketDraw = { size: number; rounds: number; matches: BracketDrawMatch[] };

/**
 * Standard seed placement for a bracket of `size` (a power of two): seed 1 meets the
 * lowest seed, and the top two seeds cannot meet before the final. Built recursively so
 * it holds at every size: `[1]`, `[1,2]`, `[1,4,2,3]`, `[1,8,4,5,2,7,3,6]`, ...
 */
export function seedPlacement(size: number): number[] {
  if (size < 1 || (size & (size - 1)) !== 0) throw new DrawError('invalid_seed_list', `Bracket size ${size} is not a power of two.`);
  let order = [1];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((seed) => [seed, doubled + 1 - seed]);
  }
  return order;
}

export function bracketSizeFor(teamCount: number): number {
  if (teamCount < 2) throw new DrawError('too_few_teams', 'A bracket needs at least two teams.');
  if (teamCount > MAX_BRACKET_SIZE) {
    throw new DrawError('too_many_teams', `A bracket holds at most ${MAX_BRACKET_SIZE} teams; got ${teamCount}.`);
  }
  let size = 2;
  while (size < teamCount) size *= 2;
  return size;
}

/**
 * A single-elimination bracket from an ordered seed list (seed 1 first). The bracket is
 * the smallest power of two that holds every team; missing seeds are byes, which by
 * construction fall only in round 1 and go to the highest seeds. Byes are resolved here:
 * the team is placed straight into its round-2 slot.
 */
export function drawBracket(input: { seeds: readonly BracketSeedEntry[]; courts: number; bestOf: BestOf }): BracketDraw {
  const seeds = [...input.seeds].sort((x, y) => x.seed - y.seed);
  seeds.forEach((entry, index) => {
    if (entry.seed !== index + 1) {
      throw new DrawError('invalid_seed_list', `Bracket seeds must be 1..${seeds.length} with no gaps; found ${entry.seed}.`);
    }
  });
  assertDistinct(seeds.map((s) => ({ id: s.teamId, seed: s.seed })));

  const size = bracketSizeFor(seeds.length);
  const rounds = Math.log2(size);
  const bySeed = (seed: number): BracketSeedEntry | null => seeds[seed - 1] ?? null;
  const placement = seedPlacement(size);

  const matches: BracketDrawMatch[] = [];
  let position = 1;
  for (let round = 1; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let index = 0; index < count; index += 1) {
      matches.push({
        position,
        round,
        indexInRound: index,
        teamAId: null,
        teamBId: null,
        teamASeed: null,
        teamBSeed: null,
        nextPosition: null,
        nextSlot: null,
        isBye: false,
        courtLabel: '',
        courtSlot: 0,
        bestOf: input.bestOf,
      });
      position += 1;
    }
  }

  const byRound = (round: number) => matches.filter((m) => m.round === round);
  for (let round = 1; round < rounds; round += 1) {
    const next = byRound(round + 1);
    for (const match of byRound(round)) {
      const target = next[Math.floor(match.indexInRound / 2)];
      if (target === undefined) throw new Error('drawBracket: missing next-round match');
      match.nextPosition = target.position;
      match.nextSlot = match.indexInRound % 2 === 0 ? 'a' : 'b';
    }
  }

  const byPosition = new Map(matches.map((m) => [m.position, m]));
  for (const match of byRound(1)) {
    const seedA = placement[match.indexInRound * 2];
    const seedB = placement[match.indexInRound * 2 + 1];
    if (seedA === undefined || seedB === undefined) throw new Error('drawBracket: placement shorter than bracket');
    const a = bySeed(seedA);
    const b = bySeed(seedB);
    if (a === null && b === null) throw new Error('drawBracket: a round-1 match with no teams');
    match.teamAId = a?.teamId ?? null;
    match.teamASeed = a === null ? null : seedA;
    match.teamBId = b?.teamId ?? null;
    match.teamBSeed = b === null ? null : seedB;
    if (a === null || b === null) {
      // A bye: normalise so the present team sits in slot A and advances at once.
      const present = a ?? b;
      const presentSeed = a === null ? seedB : seedA;
      if (present === null) throw new Error('unreachable');
      match.isBye = true;
      match.teamAId = present.teamId;
      match.teamASeed = presentSeed;
      match.teamBId = null;
      match.teamBSeed = null;
      if (match.nextPosition !== null && match.nextSlot !== null) {
        const next = byPosition.get(match.nextPosition);
        if (next === undefined) throw new Error('drawBracket: bye has no next match');
        if (match.nextSlot === 'a') {
          next.teamAId = present.teamId;
          next.teamASeed = presentSeed;
        } else {
          next.teamBId = present.teamId;
          next.teamBSeed = presentSeed;
        }
      }
    }
  }

  const courts = Math.max(1, Math.floor(input.courts));
  const nextSlot = new Map<string, number>();
  for (const match of matches) {
    if (match.isBye) {
      match.courtLabel = courtLabel(0);
      continue;
    }
    const label = courtLabel(match.indexInRound % courts);
    match.courtLabel = label;
    const slot = nextSlot.get(label) ?? 0;
    match.courtSlot = slot;
    nextSlot.set(label, slot + 1);
  }

  return { size, rounds, matches };
}

/**
 * A single-elimination draw straight from entry seeds: the seed line becomes bracket
 * seeds 1..N.
 */
export function drawSingleElimination(input: { teams: readonly DrawTeam[]; courts: number; bestOf: BestOf; rng: Rng }): BracketDraw {
  const entries = orderEntries(input.teams, input.rng);
  return drawBracket({
    seeds: entries.map((team, index) => ({ teamId: team.id, seed: index + 1 })),
    courts: input.courts,
    bestOf: input.bestOf,
  });
}

// ---- Advancement from pools --------------------------------------------------------------

export type PoolStandings = { sequence: number; standings: readonly StandingRow[] };

/**
 * Who advances from pool play and in what bracket-seed order. The top `perPool` of every
 * pool advance; then the `wildcards` best remaining teams, ranked by place in pool and
 * then the cross-pool standings comparator. Bracket seeds are assigned by place first
 * (every pool winner before every runner-up), then by that same comparator, so the
 * strongest pool winner is seed 1.
 */
export function rankForBracket(pools: readonly PoolStandings[], rule: AdvancementRule): BracketSeedEntry[] {
  const advancing: Array<{ teamId: string; place: number; row: StandingRow }> = [];
  const remaining: Array<{ teamId: string; place: number; row: StandingRow }> = [];
  for (const pool of pools) {
    pool.standings.forEach((row, index) => {
      const entry = { teamId: row.teamId, place: index + 1, row };
      if (index < rule.perPool) advancing.push(entry);
      else remaining.push(entry);
    });
  }
  if (rule.wildcards > remaining.length) {
    throw new DrawError(
      'advancement_exceeds_field',
      `The advancement rule asks for ${rule.wildcards} wildcard(s) but only ${remaining.length} team(s) remain after the top ${rule.perPool} per pool.`,
    );
  }
  const byPlaceThenStrength = (x: { place: number; row: StandingRow }, y: { place: number; row: StandingRow }) =>
    x.place - y.place || compareAcrossPools(x.row, y.row);
  remaining.sort(byPlaceThenStrength);
  const field = [...advancing, ...remaining.slice(0, rule.wildcards)].sort(byPlaceThenStrength);
  if (field.length < 2) throw new DrawError('too_few_teams', 'Fewer than two teams advance; there is no bracket to draw.');
  return field.map((entry, index) => ({ teamId: entry.teamId, seed: index + 1 }));
}
