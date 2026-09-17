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

/** Required on every Purse mutation; replaying a key returns the original result (spec §2 rule 4). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** `t=<unix>,v1=<hex>` HMAC-SHA256 over `"{t}.{rawBody}"` on outbound webhooks (spec §4.9). */
export const WEBHOOK_SIGNATURE_HEADER = 'Purse-Signature';
