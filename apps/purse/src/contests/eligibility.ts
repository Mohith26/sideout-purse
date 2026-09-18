import type { Contest } from '../db/schema';

/**
 * PHASE 3 REPLACES THIS FILE. Spec 4.5's eligibility engine (a pure evaluator over a
 * versioned ruleset, with the identity, restriction and geolocation seams) is phase 3.
 * Until then `enterContest` calls this one named hook, which always allows, so the call
 * site, the decision shape and the `not_eligible` error path exist now and phase 3 only
 * has to change what is decided, not where. The vocabulary below is spec 4.5's verbatim.
 *
 * What is already enforced at entry without this hook: `contest_not_open` and
 * `contest_full` (by `enterContest` itself, under the contest row lock) and
 * `insufficient_balance` (by the ledger's non-negative wallet rule, as `insufficient_funds`).
 */
export const ELIGIBILITY_REASONS = [
  'under_minimum_age',
  'region_not_permitted',
  'identity_unverified',
  'identity_rejected',
  'self_excluded',
  'cooling_off',
  'platform_blocked',
  'insufficient_balance',
  'stake_limit_exceeded',
  'velocity_limit_exceeded',
  'region_unknown',
  'contest_not_open',
  'contest_full',
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export const REQUIRED_ACTIONS = ['complete_identity', 'provide_demographics', 'add_funds', 'confirm_location'] as const;
export type RequiredAction = (typeof REQUIRED_ACTIONS)[number];

export type EligibilityDecision =
  | { allowed: true; rulesetVersion: string }
  | { allowed: false; rulesetVersion: string; reasons: EligibilityReason[]; requiredAction?: RequiredAction };

export type EntryEligibilityInput = {
  userId: string;
  contest: Pick<Contest, 'id' | 'asset' | 'entryAmount' | 'kind'>;
};

/** The version recorded on every decision this placeholder makes, so a persisted decision from before phase 3 is recognisable. */
export const ALLOW_ALL_RULESET_VERSION = 'allow-all.phase-2';

/** Always allows. See the file header. */
export function evaluateEntryEligibility(_input: EntryEligibilityInput): EligibilityDecision {
  return { allowed: true, rulesetVersion: ALLOW_ALL_RULESET_VERSION };
}
