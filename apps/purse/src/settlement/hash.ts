import { createHash } from 'node:crypto';

import type { Payout } from './types';

/**
 * The payout hash that makes the frozen preview a guarantee (spec 4.7): `GET .../preview`
 * returns it, `close` requires it, and a close whose recomputed hash differs is refused.
 *
 * Canonical form (docs/decisions.md, "The payout hash canonical form"): the payouts sorted
 * by placement then `userId`, each as the triple `[placement, userId, payout]` with the
 * payout as a decimal string, serialised as `{"v":1,"payouts":[...]}` with no whitespace,
 * hashed with SHA-256 and written as lowercase hex. The version field lets a later change
 * to the form be told apart from a stale preview.
 */
export const PAYOUT_HASH_VERSION = 1;

export function canonicalPayouts(payouts: readonly Payout[]): string {
  const sorted = [...payouts].sort((a, b) => a.placement - b.placement || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return JSON.stringify({ v: PAYOUT_HASH_VERSION, payouts: sorted.map((payout) => [payout.placement, payout.userId, payout.payout.toString()]) });
}

export function payoutHash(payouts: readonly Payout[]): string {
  return createHash('sha256').update(canonicalPayouts(payouts)).digest('hex');
}

/** What a well-formed hash looks like, for validating one presented by a caller before it is compared. */
export const PAYOUT_HASH_SHAPE = /^[0-9a-f]{64}$/;
