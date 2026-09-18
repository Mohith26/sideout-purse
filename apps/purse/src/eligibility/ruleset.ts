import { z } from 'zod';

/**
 * The declarative ruleset the evaluator runs (spec 4.5, decision D9): versioned, stored
 * in `rulesets`, validated here on the way in and on the way out. The shape is the spec's
 * verbatim, and it deliberately mirrors the real regulatory asymmetry: `permittedRegions`,
 * `requireVerificationAbove` and `requireKnownRegion` are keyed by asset so a free-to-play
 * asset (`POINTS`) can be permitted everywhere with no verification while a value-bearing
 * one (`CREDIT`) is region-gated and verification-gated.
 *
 * Numbers in the JSON are plain integers (a ruleset is not money and an integer is exact
 * in JSON); the evaluator turns the stake limits into `bigint` before comparing them with
 * amounts. `collusion` is phase 3's one addition, for the head-to-head signal in spec 4.6;
 * it is optional with defaults so the spec's example validates unchanged.
 */

const REGION_CODE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

export const regionCodeSchema = z.string().regex(REGION_CODE, 'must be an ISO 3166 code such as US or US-TX');

/** A version reads `YYYY.MM.n`: the year and month the rules were adopted and a counter within the month. */
export const RULESET_VERSION_SHAPE = /^\d{4}\.\d{1,2}\.\d+$/;

const limit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

const permitted = z.union([z.literal('ALL'), z.array(regionCodeSchema).max(1000)]);

export const rulesetSchema = z
  .object({
    version: z.string().regex(RULESET_VERSION_SHAPE, 'must read YYYY.MM.n'),
    minimumAge: z
      .object({
        default: z.number().int().min(0).max(150),
        byRegion: z.record(regionCodeSchema, z.number().int().min(0).max(150)),
      })
      .strict(),
    permittedRegions: z.object({ POINTS: permitted, CREDIT: permitted }).strict(),
    stakeLimits: z.object({ perContest: limit, per24h: limit, per7d: limit }).strict(),
    /** Entry amounts strictly above this need a verified identity; `null` means never. */
    requireVerificationAbove: z.object({ POINTS: limit, CREDIT: limit }).strict(),
    requireKnownRegion: z.object({ POINTS: z.boolean(), CREDIT: z.boolean() }).strict(),
    /**
     * The head-to-head collusion signal (spec 4.6): a pair that has met at least
     * `minMeetings` times with one side winning at least `oneSidedShare` of them is flagged.
     */
    collusion: z
      .object({
        minMeetings: z.number().int().min(2).max(10_000).default(5),
        oneSidedShare: z.number().min(0.5).max(1).default(0.8),
      })
      .strict()
      .default({ minMeetings: 5, oneSidedShare: 0.8 }),
  })
  .strict();

export type Ruleset = z.output<typeof rulesetSchema>;
export type RulesetInput = z.input<typeof rulesetSchema>;

/**
 * The spec 4.5 example, seeded as the first active version. `collusion` is phase 3's
 * addition and carries the schema defaults so the stored body is complete.
 */
export const SPEC_EXAMPLE_RULESET: Ruleset = {
  version: '2026.09.1',
  minimumAge: { default: 18, byRegion: { 'US-NE': 19, 'US-AL': 19, 'US-IA': 21, 'US-MA': 21 } },
  permittedRegions: { POINTS: 'ALL', CREDIT: ['US-TX', 'US-NC', 'US-CA'] },
  stakeLimits: { perContest: 50_000, per24h: 200_000, per7d: 1_000_000 },
  requireVerificationAbove: { POINTS: null, CREDIT: 0 },
  requireKnownRegion: { POINTS: false, CREDIT: true },
  collusion: { minMeetings: 5, oneSidedShare: 0.8 },
};

export class RulesetError extends Error {
  override readonly name = 'RulesetError';
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

/** Validate a ruleset body, throwing `RulesetError` with the issues when it does not conform. */
export function parseRuleset(body: unknown): Ruleset {
  const result = rulesetSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
    throw new RulesetError(`Invalid ruleset: ${issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}`, issues);
  }
  return result.data;
}
