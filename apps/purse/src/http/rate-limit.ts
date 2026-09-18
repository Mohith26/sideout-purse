import type { MiddlewareHandler } from 'hono';
import { RATE_LIMIT_LIMIT_HEADER, RATE_LIMIT_REMAINING_HEADER, RATE_LIMIT_RESET_HEADER, RETRY_AFTER_HEADER } from '@purse/types';

import { limiterKeyOf } from './auth';
import { ApiFailure } from './envelope';

/**
 * A per-key token bucket (spec 4.7 `rate_limited`). Each key's bucket holds `burst`
 * tokens and refills at `perSecond`; a request takes one, and an empty bucket answers 429
 * with `Retry-After` and the sealed `rate_limited` error. Keyed by the presented key's
 * visible prefix, so it runs before authentication and also throttles guessing; requests
 * with no usable key share one anonymous bucket.
 *
 * Buckets live in process memory: one replica, one view. A shared store is a phase 9
 * concern (docs/decisions.md).
 */
export type RateLimitConfig = {
  /** Bucket capacity: how many requests may arrive at once. */
  burst: number;
  /** Sustained rate. */
  perSecond: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { burst: 100, perSecond: 20 };

type Bucket = { tokens: number; updatedAt: number };

const SWEEP_AT = 10_000;
const IDLE_MS = 10 * 60_000;

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(readonly config: RateLimitConfig) {
    if (config.burst < 1 || config.perSecond <= 0) throw new RangeError('rate limit needs burst >= 1 and perSecond > 0');
  }

  /** Take one token for `key` at `now`; reports what is left, or how long until one is available. */
  take(key: string, now: number): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const bucket = this.buckets.get(key) ?? { tokens: this.config.burst, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.config.burst, bucket.tokens + (elapsed / 1000) * this.config.perSecond);
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    this.buckets.set(key, bucket);
    if (this.buckets.size > SWEEP_AT) this.sweep(now);
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(((1 - bucket.tokens) / this.config.perSecond) * 1000) };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.updatedAt > IDLE_MS) this.buckets.delete(key);
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function rateLimit(buckets: TokenBuckets, clock: () => number = Date.now): MiddlewareHandler {
  return async (c, next) => {
    const key = limiterKeyOf(c.req.header('Authorization'));
    const result = buckets.take(key, clock());
    c.header(RATE_LIMIT_LIMIT_HEADER, String(buckets.config.burst));
    c.header(RATE_LIMIT_REMAINING_HEADER, String(result.remaining));
    if (!result.allowed) {
      const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      c.header(RETRY_AFTER_HEADER, String(seconds));
      c.header(RATE_LIMIT_RESET_HEADER, String(seconds));
      throw new ApiFailure(
        { type: 'rate_limited', code: 'too_many_requests', message: `Rate limit exceeded; retry in ${seconds}s`, detail: { retryAfterSeconds: seconds, limit: buckets.config.burst } },
        429,
      );
    }
    await next();
  };
}
