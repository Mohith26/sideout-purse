import { z } from 'zod';

/**
 * Cents cross the JSON boundary as decimal strings, in both directions, so no client is
 * tempted into floating-point arithmetic on a donation and no server path ever holds a
 * `number` of cents: a JSON number is refused rather than parsed through a double.
 * Inside the server everything is `bigint`.
 */
export const centsSchema = z
  .string()
  .regex(/^\d{1,18}$/, 'cents must be a non-negative integer string')
  .transform((value) => BigInt(value));

export function centsToJson(value: bigint): string {
  return value.toString();
}

/** Integer percent of `part` over `whole`, floored, capped at 100; 0 when the goal is 0. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const pct = (part * 100n) / whole;
  return Number(pct > 100n ? 100n : pct);
}

/** The one real currency Sideout moves; donations record it explicitly on every row. */
export const DONATION_CURRENCY = 'USD';
