import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BACKOFF_SECONDS, JITTER, WEBHOOK_MAX_ATTEMPTS, retryDelayMs, scheduleTotalSeconds } from '../../src/webhooks';

/**
 * The retry schedule's bounds (spec 4.9: eight attempts over roughly twenty-four hours),
 * as properties over every failed attempt number and every random draw.
 */
describe('webhook retry schedule', () => {
  it('is eight attempts whose base delays sum to roughly a day', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
    expect(BACKOFF_SECONDS).toHaveLength(WEBHOOK_MAX_ATTEMPTS - 1);
    const hours = scheduleTotalSeconds() / 3600;
    expect(hours).toBeGreaterThan(20);
    expect(hours).toBeLessThan(26);
    for (let i = 1; i < BACKOFF_SECONDS.length; i += 1) expect(BACKOFF_SECONDS[i]).toBeGreaterThan(BACKOFF_SECONDS[i - 1] ?? 0);
  });

  it('every delay stays within the jitter band of its base and the eighth failure is dead', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: WEBHOOK_MAX_ATTEMPTS - 1 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (failed, r) => {
        const delay = retryDelayMs(failed, () => r);
        const base = (BACKOFF_SECONDS[failed - 1] ?? 0) * 1000;
        expect(delay).toBeDefined();
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - JITTER)));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + JITTER)));
        expect(Number.isInteger(delay)).toBe(true);
      }),
      { numRuns: 2000 },
    );
    expect(retryDelayMs(WEBHOOK_MAX_ATTEMPTS, () => 0.5)).toBeUndefined();
    expect(retryDelayMs(WEBHOOK_MAX_ATTEMPTS + 3, () => 0.5)).toBeUndefined();
  });

  it('is non-decreasing across attempts for any fixed draw, and the whole walk lands within a day give or take the jitter', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (r) => {
        let previous = 0;
        let total = 0;
        for (let failed = 1; failed < WEBHOOK_MAX_ATTEMPTS; failed += 1) {
          const delay = retryDelayMs(failed, () => r) ?? -1;
          expect(delay).toBeGreaterThanOrEqual(previous);
          previous = delay;
          total += delay;
        }
        const hours = total / 3_600_000;
        expect(hours).toBeGreaterThanOrEqual(scheduleTotalSeconds() * (1 - JITTER) / 3600 - 0.01);
        expect(hours).toBeLessThanOrEqual(scheduleTotalSeconds() * (1 + JITTER) / 3600 + 0.01);
        expect(hours).toBeGreaterThan(17);
        expect(hours).toBeLessThan(27);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses a bad attempt number or a bad random source', () => {
    expect(() => retryDelayMs(0, () => 0.5)).toThrow(RangeError);
    expect(() => retryDelayMs(1.5, () => 0.5)).toThrow(RangeError);
    expect(() => retryDelayMs(1, () => 1)).toThrow(RangeError);
    expect(() => retryDelayMs(1, () => Number.NaN)).toThrow(RangeError);
  });
});
