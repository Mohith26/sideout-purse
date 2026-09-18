/**
 * The sealed eligibility taxonomy (system spec 4.5). The SDK surfaces exactly these
 * variants and a partner branches on the variant, never on a message string: message copy
 * is a presentation concern that changes, the variant is the contract. Purse's evaluator
 * (`apps/purse/src/eligibility`) produces them; nothing else may add a value here.
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

/** What a `not_eligible` error carries in its `detail` (spec 4.7). */
export type NotEligibleDetail = {
  reasons: EligibilityReason[];
  requiredAction?: RequiredAction;
  rulesetVersion: string;
};

export function isEligibilityReason(value: unknown): value is EligibilityReason {
  return typeof value === 'string' && (ELIGIBILITY_REASONS as readonly string[]).includes(value);
}

export function isRequiredAction(value: unknown): value is RequiredAction {
  return typeof value === 'string' && (REQUIRED_ACTIONS as readonly string[]).includes(value);
}
