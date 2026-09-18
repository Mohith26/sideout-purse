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

/**
 * `detail` is optional structured context a partner can act on: `not_eligible` carries
 * `reasons[]` and `requiredAction`, an invariant failure carries the reconcile report.
 * It never contains a connection string, a key, or a stack.
 */
export type ApiError = { type: ApiErrorType; code: string; message: string; detail?: Record<string, unknown> };

export type ApiErrorEnvelope = { error: ApiError };
export type ApiDataEnvelope<T> = { data: T };
