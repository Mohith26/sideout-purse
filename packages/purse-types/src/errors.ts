/**
 * The Purse API error taxonomy (system spec section 4.7).
 *
 * Every non-2xx response is `{ error: ApiError }` and every success is `{ data }`. The
 * `type` field is sealed: partners branch on it, never on `message`, which is
 * presentation copy that may change. `code` is a stable machine-readable refinement
 * within a type (for example `invalid_request` / `missing_idempotency_key`).
 */

export const API_ERROR_TYPES = [
  'invalid_request',
  'authentication_error',
  'permission_error',
  'not_eligible',
  'insufficient_funds',
  'invalid_state',
  'conflict',
  'rate_limited',
  'internal_error',
] as const;

export type ApiErrorType = (typeof API_ERROR_TYPES)[number];

/** HTTP status Purse uses for each error type. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorType, number>> = {
  invalid_request: 400,
  authentication_error: 401,
  permission_error: 403,
  not_eligible: 403,
  insufficient_funds: 402,
  invalid_state: 409,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

/** Why an eligibility evaluation said no (system spec section 4.5). Sealed. */
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

/** What a user can do about a `not_eligible` decision, when anything. Sealed. */
export const REQUIRED_ACTIONS = [
  'complete_identity',
  'provide_demographics',
  'add_funds',
  'confirm_location',
] as const;

export type RequiredAction = (typeof REQUIRED_ACTIONS)[number];

type ErrorShape<T extends ApiErrorType, Detail = undefined> = Detail extends undefined
  ? { type: T; code: string; message: string; detail?: unknown }
  : { type: T; code: string; message: string; detail: Detail };

/** Carried by `not_eligible`, and the only detail shape a partner is expected to branch on. */
export type NotEligibleDetail = {
  reasons: EligibilityReason[];
  requiredAction?: RequiredAction;
  /** The ruleset in force when the decision was made (decision D9). */
  rulesetVersion: string;
};

export type InsufficientFundsDetail = {
  asset: string;
  /** Minor units, serialised as a decimal string because JSON has no bigint. */
  required: string;
  available: string;
};

export type ApiError =
  | ErrorShape<'invalid_request'>
  | ErrorShape<'authentication_error'>
  | ErrorShape<'permission_error'>
  | ErrorShape<'not_eligible', NotEligibleDetail>
  | ErrorShape<'insufficient_funds', InsufficientFundsDetail>
  | ErrorShape<'invalid_state'>
  | ErrorShape<'conflict'>
  | ErrorShape<'rate_limited'>
  | ErrorShape<'internal_error'>;

export type ApiErrorEnvelope = { error: ApiError };
export type ApiDataEnvelope<T> = { data: T };
export type ApiEnvelope<T> = ApiDataEnvelope<T> | ApiErrorEnvelope;

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  if (typeof error !== 'object' || error === null || !('type' in error)) return false;
  return typeof error.type === 'string' && (API_ERROR_TYPES as readonly string[]).includes(error.type);
}
