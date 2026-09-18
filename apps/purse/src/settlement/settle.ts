import { SettlementError } from './errors';
import { prizeStructureSchema, type Payout, type PrizeStructure, type SettleEntry, type SettleInput, type TieBreakRule } from './types';

/**
 * The settlement engine, spec 4.4. A pure function: no database, no clock, no randomness,
 * no dependence on input order. Same input, same output, byte for byte.
 *
 * How a pool becomes payouts:
 *
 *   1. Rank. Entrants sort by score, highest first. Unscored entrants (score `null`) are
 *      one group after every scored one. Equal scores are a tie; the tie-break rule may
 *      split the tie (`higher_seed_wins`: the lower seed number wins; `earliest_submission_wins`:
 *      the earlier counting score wins) or leave it (`split_evenly`, or the rule's key is
 *      equal or missing on both sides). Tied entrants share a placement in competition
 *      ranking (1, 2, 2, 4) and are ordered among themselves by ascending `userId`.
 *
 *   2. Floor. If the structure defines a `participationFloor`, every entrant, scored or not,
 *      receives it from the pool first. A pool that cannot cover the floor for everyone is
 *      split evenly instead and nothing is left for placements.
 *
 *   3. Prize vector. The structure turns what remains into one amount per placement slot,
 *      best first, summing exactly to the remainder. Only scored entrants occupy slots, so
 *      weights beyond the last scored placement are simply not used and the whole
 *      remainder is shared by those who placed; a contest in which nobody scored has one
 *      group holding every slot, so the remainder is split evenly among all entrants.
 *
 *   4. Ties. A tie group takes the sum of its slots' amounts and shares it evenly.
 *
 * THE ROUNDING RULE (spec 4.4 rule 3; also documented in the settlement README): every
 * share is floor division in bigint. What the floors leave over is handed out one minor
 * unit at a time in descending placement order, meaning the best placement first, then the
 * next, and so on; within a tie group, by ascending `userId`. Nothing is ever lost:
 * 100 units split three ways is 34/33/33, never 33/33/33 with a unit missing.
 *
 * Every amount is `bigint`. Scores are numbers used for ordering only; no float ever
 * touches a payout.
 */
export function settle(input: SettleInput): Payout[] {
  const structure = validateStructure(input.prizeStructure);
  const escrowTotal = validateEscrow(input.escrowTotal);
  const entries = validateEntries(input.entries);

  if (entries.length === 0) {
    if (escrowTotal !== 0n) {
      throw new SettlementError('no_recipients', `A pool of ${escrowTotal} has no entrants to pay`, { escrowTotal: escrowTotal.toString() });
    }
    return [];
  }

  const ranked = rank(entries, input.tieBreak);
  const ordered = ranked.flatMap((group) => group.members);
  const scoredCount = entries.filter((entry) => entry.score !== null).length;

  let pool = escrowTotal;
  let floorShares: bigint[] = ordered.map(() => 0n);
  const floor = structure.participationFloor === undefined ? 0n : BigInt(structure.participationFloor);
  if (floor > 0n) {
    const floorTotal = min(pool, floor * BigInt(ordered.length));
    floorShares = evenSplit(floorTotal, ordered.length);
    pool -= floorTotal;
  }

  // Only scored entrants occupy prize slots; with nobody scored, everyone does.
  const slots = scoredCount > 0 ? scoredCount : ordered.length;
  const vector = prizeVector(structure, pool, slots);

  const payouts: Payout[] = [];
  let position = 0;
  for (const group of ranked) {
    let combined = 0n;
    for (let slot = position; slot < position + group.members.length; slot += 1) combined += vector[slot] ?? 0n;
    const shares = evenSplit(combined, group.members.length);
    group.members.forEach((member, index) => {
      payouts.push({
        userId: member.userId,
        placement: group.placement,
        payout: (floorShares[position + index] ?? 0n) + (shares[index] ?? 0n),
      });
    });
    position += group.members.length;
  }

  return payouts;
}

// ---- ranking -------------------------------------------------------------------------

type Group = { placement: number; members: SettleEntry[] };

/** Sorted, grouped into ties, with competition-ranking placements. Independent of input order. */
export function rank(entries: readonly SettleEntry[], tieBreak: TieBreakRule): Group[] {
  const sorted = [...entries].sort((a, b) => compareEntries(a, b, tieBreak));
  const groups: Group[] = [];
  for (const entry of sorted) {
    const last = groups[groups.length - 1];
    const head = last?.members[0];
    if (last !== undefined && head !== undefined && tied(head, entry, tieBreak)) {
      last.members.push(entry);
    } else {
      groups.push({ placement: groups.reduce((sum, group) => sum + group.members.length, 0) + 1, members: [entry] });
    }
  }
  return groups;
}

/** Total order: score descending with unscored last, then the tie-break key, then userId ascending. */
function compareEntries(a: SettleEntry, b: SettleEntry, tieBreak: TieBreakRule): number {
  return compareScore(a, b) || (a.score === null ? 0 : compareTieKey(a, b, tieBreak)) || compareStrings(a.userId, b.userId);
}

/** Tied: same score (both scored) and the tie-break rule cannot separate them, or both unscored. */
function tied(a: SettleEntry, b: SettleEntry, tieBreak: TieBreakRule): boolean {
  if (a.score === null || b.score === null) return a.score === null && b.score === null;
  return compareScore(a, b) === 0 && compareTieKey(a, b, tieBreak) === 0;
}

function compareScore(a: SettleEntry, b: SettleEntry): number {
  if (a.score === null) return b.score === null ? 0 : 1;
  if (b.score === null) return -1;
  return a.score > b.score ? -1 : a.score < b.score ? 1 : 0;
}

function compareTieKey(a: SettleEntry, b: SettleEntry, tieBreak: TieBreakRule): number {
  switch (tieBreak) {
    case 'split_evenly':
      return 0;
    case 'higher_seed_wins':
      return compareAscendingNullsLast(a.seed ?? null, b.seed ?? null);
    case 'earliest_submission_wins':
      return compareAscendingNullsLast(instant(a.submittedAt), instant(b.submittedAt));
  }
}

function compareAscendingNullsLast(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function instant(value: string | null | undefined): number | null {
  return value === undefined || value === null ? null : Date.parse(value);
}

// ---- amounts ---------------------------------------------------------------------------

/**
 * One amount per placement slot, best first, summing exactly to `pool`. Weights past
 * `slots` are dropped; a shorter list is padded with zero weight.
 */
function prizeVector(structure: PrizeStructure, pool: bigint, slots: number): bigint[] {
  if (structure.type === 'guaranteed_minimum') {
    const minimums = fit(structure.minimums.map(BigInt), slots);
    const guaranteed = minimums.reduce((sum, amount) => sum + amount, 0n);
    if (pool >= guaranteed) {
      const rest = proportional(pool - guaranteed, fit(structure.percentages.map(BigInt), slots));
      return minimums.map((amount, index) => amount + (rest[index] ?? 0n));
    }
    // The pool cannot honour every floor: pay them best placement first until it runs out.
    let remaining = pool;
    return minimums.map((amount) => {
      const paid = min(amount, remaining);
      remaining -= paid;
      return paid;
    });
  }
  return proportional(pool, fit(weights(structure), slots));
}

function weights(structure: Exclude<PrizeStructure, { type: 'guaranteed_minimum' }>): bigint[] {
  switch (structure.type) {
    case 'winner_take_all':
      return [1n];
    case 'percentage_split':
      return structure.percentages.map(BigInt);
    case 'placement_table':
      return structure.placements.map((row) => ('amount' in row ? BigInt(row.amount) : BigInt(row.percent)));
    case 'top_n_equal':
      return Array.from({ length: structure.n }, () => 1n);
  }
}

/** Truncate or zero-pad to exactly `length` entries. */
function fit(values: readonly bigint[], length: number): bigint[] {
  return Array.from({ length }, (_, index) => values[index] ?? 0n);
}

/**
 * Share `pool` in proportion to `weights`: floor division, then the remainder one unit at
 * a time from the first slot. With non-increasing weights the result is non-increasing,
 * and the remainder (fewer units than there are positive weights) never reaches a slot
 * with zero weight.
 */
export function proportional(pool: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (total === 0n) return weights.map((_, index) => (index === 0 ? pool : 0n));
  const shares = weights.map((weight) => (pool * weight) / total);
  let remainder = pool - shares.reduce((sum, share) => sum + share, 0n);
  for (let index = 0; remainder > 0n && index < shares.length; index += 1) {
    shares[index] = (shares[index] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return shares;
}

/** `count` shares of `total`, as equal as integers allow, the leftover units going to the first shares. */
export function evenSplit(total: bigint, count: number): bigint[] {
  if (count === 0) return [];
  const divisor = BigInt(count);
  const base = total / divisor;
  const leftover = Number(total % divisor);
  return Array.from({ length: count }, (_, index) => (index < leftover ? base + 1n : base));
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// ---- validation ----------------------------------------------------------------------

function validateStructure(structure: PrizeStructure): PrizeStructure {
  const parsed = prizeStructureSchema.safeParse(structure);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SettlementError('invalid_structure', `Invalid prize structure: ${issue?.message ?? 'unknown'}`, {
      path: issue?.path.map(String).join('.') ?? '',
    });
  }
  return parsed.data;
}

function validateEscrow(escrowTotal: bigint): bigint {
  if (typeof escrowTotal !== 'bigint' || escrowTotal < 0n) {
    throw new SettlementError('negative_escrow', 'escrowTotal must be a non-negative bigint', {
      escrowTotal: typeof escrowTotal === 'bigint' ? escrowTotal.toString() : String(escrowTotal),
    });
  }
  return escrowTotal;
}

function validateEntries(entries: readonly SettleEntry[]): SettleEntry[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (typeof entry.userId !== 'string' || entry.userId.length === 0) {
      throw new SettlementError('invalid_entry', `Entry ${index}: userId must be a non-empty string`, { index });
    }
    if (seen.has(entry.userId)) {
      throw new SettlementError('duplicate_entrant', `Entry ${index}: ${entry.userId} appears more than once`, { index, userId: entry.userId });
    }
    seen.add(entry.userId);
    if (entry.score !== null && (typeof entry.score !== 'number' || !Number.isFinite(entry.score))) {
      throw new SettlementError('invalid_entry', `Entry ${index}: score must be a finite number or null`, { index, userId: entry.userId });
    }
    if (entry.seed !== undefined && entry.seed !== null && (typeof entry.seed !== 'number' || !Number.isFinite(entry.seed))) {
      throw new SettlementError('invalid_entry', `Entry ${index}: seed must be a finite number when present`, { index, userId: entry.userId });
    }
    if (entry.submittedAt !== undefined && entry.submittedAt !== null && Number.isNaN(Date.parse(entry.submittedAt))) {
      throw new SettlementError('invalid_entry', `Entry ${index}: submittedAt must be an ISO 8601 instant when present`, { index, userId: entry.userId });
    }
    return { userId: entry.userId, score: entry.score, seed: entry.seed ?? null, submittedAt: entry.submittedAt ?? null };
  });
}
