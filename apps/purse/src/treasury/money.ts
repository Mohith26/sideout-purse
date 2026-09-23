/**
 * Money formatting and the one conversion this system performs (spec 13.1).
 *
 * `CREDIT` is a claim on custodied dollars at exactly one minor unit to one US cent, so
 * the conversion is the identity function. That is deliberate, and writing it out rather
 * than leaving it implicit is the point: the moment a rate appears here, somebody has
 * introduced foreign exchange into a ledger that has no way to express a gain or a loss on
 * it, and the invariants would start failing for reasons nobody could read.
 *
 * Everything is `bigint` cents. There is no float anywhere in the money path, here or in
 * the journal, and `formatUsd` is the only thing that ever produces a decimal point.
 */

/** One CREDIT is one US cent. */
export const CENTS_PER_CREDIT = 1n;

/** US cents to the closed-loop claim recorded in the ledger. */
export function centsToCredit(cents: bigint): bigint {
  return cents / CENTS_PER_CREDIT;
}

/** The claim recorded in the ledger, back to US cents. */
export function creditToCents(credit: bigint): bigint {
  return credit * CENTS_PER_CREDIT;
}

/**
 * `$1,234.56`. Negative amounts keep the sign in front of the symbol (`-$4.00`), which is
 * what a ledger reader expects; `Intl` would render `($4.00)` in some locales.
 */
export function formatUsd(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const dollars = absolute / 100n;
  const remainder = absolute % 100n;
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * Basis points of an amount, rounded down. Rounding down is the rule everywhere money is
 * split in this system: the remainder stays in the pool that was being divided rather than
 * being created out of nothing, so the rake can never exceed the escrow it came from.
 */
export function applyBps(amount: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  return (amount * BigInt(bps)) / 10_000n;
}
