import { z } from 'zod';

/**
 * The configuration a draw was produced with. Persisted on `tournaments.draw_config` at
 * the pools stage (or the single stage of a single-elimination draw) so the bracket stage
 * reads it back rather than trusting the caller to resend it, and so a redraw with the
 * same `rngSeed` reproduces the same pools.
 *
 * `double_elim` is deliberately absent: the format stays in the tournament enum but the
 * engine refuses to draw it (see docs/decisions.md).
 */
export const DRAW_CONFIG_VERSION = 1;

const bestOf = z.union([z.literal(1), z.literal(3)]);
const courts = z.number().int().min(1).max(64);
const rngSeed = z.number().int().min(0).max(0xffff_ffff);

export const advancementRuleSchema = z.object({
  /** Teams that advance from every pool, taken from the top of its standings. */
  perPool: z.number().int().min(1).max(8),
  /** Best remaining teams across all pools, ranked by place then the standings tiebreak. */
  wildcards: z.number().int().min(0).max(32),
});
export type AdvancementRule = z.infer<typeof advancementRuleSchema>;

export const drawConfigSchema = z.discriminatedUnion('format', [
  z.object({
    version: z.literal(DRAW_CONFIG_VERSION),
    format: z.literal('pool_to_bracket'),
    courts,
    poolSize: z.number().int().min(2).max(8),
    advancement: advancementRuleSchema,
    rngSeed,
    bestOf: z.object({ pool: bestOf, bracket: bestOf }),
  }),
  z.object({
    version: z.literal(DRAW_CONFIG_VERSION),
    format: z.literal('single_elim'),
    courts,
    rngSeed,
    bestOf: z.object({ bracket: bestOf }),
  }),
  z.object({
    version: z.literal(DRAW_CONFIG_VERSION),
    format: z.literal('round_robin'),
    courts,
    rngSeed,
    bestOf: z.object({ pool: bestOf }),
  }),
]);

export type DrawConfig = z.infer<typeof drawConfigSchema>;
export type PoolToBracketConfig = Extract<DrawConfig, { format: 'pool_to_bracket' }>;
export type SingleElimConfig = Extract<DrawConfig, { format: 'single_elim' }>;
export type RoundRobinConfig = Extract<DrawConfig, { format: 'round_robin' }>;

/** Defaults an organizer gets when the draw request leaves a knob unset. */
export const DRAW_DEFAULTS = {
  courts: 4,
  poolSize: 4,
  advancement: { perPool: 2, wildcards: 0 } satisfies AdvancementRule,
  bestOf: { pool: 1, bracket: 3 } as const,
} as const;
