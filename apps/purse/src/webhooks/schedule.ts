import { WEBHOOK_MAX_ATTEMPTS } from '../db/schema';

/**
 * The retry schedule (spec 4.9): eight attempts over roughly twenty-four hours, then
 * `dead`. The first attempt is immediate; after the n-th failure the next attempt waits
 * `BACKOFF_SECONDS[n - 1]` with ±`JITTER` of uniform jitter, so a fleet of endpoints that
 * went down together does not come back to one thundering retry. The base delays sum to
 * 22 h 21 m; with the jitter the eighth attempt lands between 17.9 and 26.8 hours after
 * the first (`test/webhooks/schedule.test.ts` holds those bounds).
 *
 * Pure: the caller passes the random source, and the dispatcher passes its clock, so a
 * test can walk the whole schedule in milliseconds.
 */
export { WEBHOOK_MAX_ATTEMPTS };

/** Seconds to wait after the 1st, 2nd, ... 7th failure: 1 m, 5 m, 15 m, 1 h, 3 h, 6 h, 12 h. */
export const BACKOFF_SECONDS: readonly number[] = [60, 300, 900, 3600, 10_800, 21_600, 43_200];

export const JITTER = 0.2;

/**
 * How long to wait after `failedAttempt` (1-based) before the next attempt, in
 * milliseconds, or `undefined` when the schedule is exhausted and the delivery is dead.
 */
export function retryDelayMs(failedAttempt: number, random: () => number = Math.random): number | undefined {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) throw new RangeError(`failedAttempt must be a positive integer, got ${failedAttempt}`);
  if (failedAttempt >= WEBHOOK_MAX_ATTEMPTS) return undefined;
  const base = BACKOFF_SECONDS[failedAttempt - 1];
  if (base === undefined) return undefined;
  const r = random();
  if (!(r >= 0 && r < 1)) throw new RangeError('random() must return a number in [0, 1)');
  const factor = 1 + JITTER * (2 * r - 1);
  return Math.round(base * factor * 1000);
}

/** The base delays summed: the schedule's nominal length. */
export function scheduleTotalSeconds(): number {
  return BACKOFF_SECONDS.reduce((sum, seconds) => sum + seconds, 0);
}
