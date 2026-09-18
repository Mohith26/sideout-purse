/**
 * HTTP header names shared by Purse, its SDK, and any partner server.
 *
 * Header names are case-insensitive on the wire; these are the canonical spellings Purse
 * emits.
 */

/**
 * Correlates one request across the service boundary. Sideout mints it (or accepts the
 * caller's), forwards it on every Purse call, and both sides log it, so a single Sideout
 * request can be traced into the Purse calls it caused (system spec section 10).
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * What a caller-supplied request id must look like to be kept rather than replaced. Both
 * services apply this one test, so an id Sideout mints survives the hop into Purse.
 */
export const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{8,128}$/;

export function isRequestId(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && REQUEST_ID_SHAPE.test(value);
}

/**
 * Every v1 mutation carries one (system spec section 2, rule 4). Purse stores the first
 * response under the key and returns it, unchanged, to every replay; the same key with a
 * different request is a `conflict`.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** `true` on a response that was served from a stored earlier response rather than performed again. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** What an `Idempotency-Key` must look like: 1 to 200 characters, no whitespace or control characters. */
export const IDEMPOTENCY_KEY_MAX = 200;
export const IDEMPOTENCY_KEY_SHAPE = /^[^\s\p{C}]{1,200}$/u;

export function isIdempotencyKey(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && IDEMPOTENCY_KEY_SHAPE.test(value);
}

/** Rate-limit headers (IETF draft-ietf-httpapi-ratelimit-headers), plus `Retry-After` on a 429. */
export const RATE_LIMIT_LIMIT_HEADER = 'RateLimit-Limit';
export const RATE_LIMIT_REMAINING_HEADER = 'RateLimit-Remaining';
export const RATE_LIMIT_RESET_HEADER = 'RateLimit-Reset';
export const RETRY_AFTER_HEADER = 'Retry-After';
