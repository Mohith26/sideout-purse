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
