import { z } from 'zod';

/**
 * The declarative inputs of the settlement engine (spec 4.4, decision D10): a prize
 * structure compiled to payouts by `settle`, and a tie-break rule. Nothing here touches
 * a database; the Zod schemas are what `contests.prize_structure` is validated against on
 * the way in, and what the engine trusts on the way out.
 *
 * Money is `bigint`. In JSON an amount is a decimal string, never a number, so the
 * structure survives a round trip through jsonb without a float anywhere near it.
 * Percentages are whole numbers of percent (an integer is exact in JSON and exact as a
 * bigint weight); a structure that needs finer shares uses a `placement_table` of amounts.
 */

export const TIE_BREAK_RULES = ['split_evenly', 'higher_seed_wins', 'earliest_submission_wins'] as const;
export type TieBreakRule = (typeof TIE_BREAK_RULES)[number];

export const PRIZE_STRUCTURE_TYPES = ['winner_take_all', 'placement_table', 'percentage_split', 'top_n_equal', 'guaranteed_minimum'] as const;
export type PrizeStructureType = (typeof PRIZE_STRUCTURE_TYPES)[number];

const AMOUNT_SHAPE = /^(0|[1-9][0-9]*)$/;

/** The bigint an amount string denotes, or zero for a string the schema will reject anyway (refinements run even when a sibling check failed). */
function toAmount(value: unknown): bigint {
  return typeof value === 'string' && AMOUNT_SHAPE.test(value) ? BigInt(value) : 0n;
}

/** A non-negative integer amount of minor units, as it appears in JSON. */
const amountString = z
  .string()
  .regex(AMOUNT_SHAPE, 'must be a non-negative integer written as a decimal string')
  .refine((value) => toAmount(value) <= 9_223_372_036_854_775_807n, 'exceeds the largest representable amount');

const percent = z.number().int().min(0).max(100);

/** Placements are paid best first, so a prize list must never pay a lower placement more than a higher one. */
function nonIncreasing(values: readonly bigint[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? 0n) >= value);
}

const percentages = z
  .array(percent)
  .min(1)
  .max(1000)
  .refine((values) => values.reduce((sum, value) => sum + value, 0) === 100, 'percentages must sum to exactly 100')
  .refine((values) => nonIncreasing(values.map((value) => (Number.isInteger(value) ? BigInt(value) : 0n))), 'percentages must not increase from one placement to the next');

/**
 * An optional floor every entrant receives before any placement prize, scored or not
 * (spec 4.4 rule 5: unscored entries receive nothing "unless the structure defines a
 * participation floor"). Paid evenly to every entrant from the pool; if the pool cannot
 * cover it, the pool is split evenly instead and nothing is left for placements.
 */
const participationFloor = { participationFloor: amountString.optional() };

const placementRow = z.object({ placement: z.number().int().min(1) });

function weightOf(row: { amount: string } | { percent: number }): bigint {
  return 'amount' in row ? toAmount(row.amount) : Number.isInteger(row.percent) ? BigInt(row.percent) : 0n;
}

const placementTableRows = z
  .union([
    z.array(placementRow.extend({ amount: amountString }).strict()).min(1).max(1000),
    z.array(placementRow.extend({ percent }).strict()).min(1).max(1000),
  ])
  .refine(
    (rows) => rows.every((row, index) => row.placement === index + 1),
    'placements must be listed in order starting at 1 with none missing',
  )
  .refine((rows) => nonIncreasing(rows.map(weightOf)), 'a lower placement must not pay more than a higher one')
  .refine((rows) => rows.some((row) => weightOf(row) > 0n), 'at least one placement must pay')
  .refine(
    (rows) => rows.every((row) => 'amount' in row) || rows.reduce((sum, row) => sum + ('percent' in row ? row.percent : 0), 0) === 100,
    'percentages must sum to exactly 100',
  );

export const prizeStructureSchema = z.discriminatedUnion('type', [
  /** The best placement takes the whole pool. */
  z.object({ type: z.literal('winner_take_all'), ...participationFloor }).strict(),
  /**
   * Explicit amounts or percentages per placement. Both are weights: when the pool equals
   * the amounts' total every placement is paid exactly its amount, and otherwise the pool
   * is shared in the same proportions, so a table never pays out more or less than the
   * pool holds.
   */
  z.object({ type: z.literal('placement_table'), placements: placementTableRows, ...participationFloor }).strict(),
  /** `[50, 30, 20]`: percent of the pool per placement, best first. */
  z.object({ type: z.literal('percentage_split'), percentages, ...participationFloor }).strict(),
  /** The top N placements share the pool evenly. */
  z.object({ type: z.literal('top_n_equal'), n: z.number().int().min(1).max(1000), ...participationFloor }).strict(),
  /**
   * A guaranteed floor per placement, then the remainder of the pool by percentage. When
   * the pool cannot cover every floor, floors are honoured best placement first until it
   * runs out.
   */
  z
    .object({
      type: z.literal('guaranteed_minimum'),
      minimums: z
        .array(amountString)
        .min(1)
        .max(1000)
        .refine((values) => nonIncreasing(values.map(toAmount)), 'minimums must not increase from one placement to the next'),
      percentages,
      ...participationFloor,
    })
    .strict(),
]);

export type PrizeStructure = z.infer<typeof prizeStructureSchema>;

export const tieBreakRuleSchema = z.enum(TIE_BREAK_RULES);

/** One entrant as the engine sees it. `seed` and `submittedAt` only matter to the tie-break rules that name them. */
export type SettleEntry = {
  userId: string;
  /** `null` when the entrant has no score: they place last and receive nothing (spec 4.4 rule 5). Not money; ordering only. */
  score: number | null;
  /** Lower is better: seed 1 is the top seed. Unseeded entrants lose a `higher_seed_wins` tie to seeded ones. */
  seed?: number | null;
  /** ISO 8601 instant the counting score was submitted. Earlier wins an `earliest_submission_wins` tie. */
  submittedAt?: string | null;
};

export type SettleInput = {
  asset: 'POINTS' | 'CREDIT';
  escrowTotal: bigint;
  entries: readonly SettleEntry[];
  prizeStructure: PrizeStructure;
  tieBreak: TieBreakRule;
};

export type Payout = {
  userId: string;
  /** Competition ranking: tied entrants share a placement and the next placement is skipped (1, 2, 2, 4). */
  placement: number;
  payout: bigint;
};
