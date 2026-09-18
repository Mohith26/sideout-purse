import type { HttpBindings } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';
import { RATE_LIMIT_LIMIT_HEADER, RATE_LIMIT_REMAINING_HEADER, RATE_LIMIT_RESET_HEADER, RETRY_AFTER_HEADER } from '@purse/types';

import type { AuthenticatedKey } from '../auth/api-keys';
import { isAuthError } from '../auth/errors';
import type { AuthScope } from './auth';
import { ApiFailure } from './envelope';

/**
 * Token buckets for `/v1` (spec 4.7 `rate_limited`). A bucket holds `burst` tokens and
 * refills at `perSecond`; a request takes one, and an empty bucket answers 429 with
 * `Retry-After` and the sealed `rate_limited` error.
 *
 * A request spends from one of two kinds of bucket. An authenticated request spends from
 * its key's, keyed by the key's id, which only the key itself can reach: a stranger who
 * knows a partner's visible prefix (it is shown in the console and in error details)
 * cannot spend the partner's tokens. A request that fails authentication spends from its
 * address's, so guessing is throttled where it comes from; once an address has spent its
 * bucket on failures, its next request is refused before the argon2 verification it would
 * cost. Nothing is ever keyed by the prefix.
 *
 * Buckets live in process memory, at most `MAX_BUCKETS` of them, the least recently used
 * evicted first: one replica, one view. A shared store is a phase 9 concern
 * (docs/decisions.md).
 */
export type RateLimitConfig = {
  /** Bucket capacity: how many requests may arrive at once. */
  burst: number;
  /** Sustained rate. */
  perSecond: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { burst: 100, perSecond: 20 };

type Bucket = { tokens: number; updatedAt: number };

export const MAX_BUCKETS = 10_000;
const IDLE_MS = 10 * 60_000;

export type Taken = { allowed: boolean; remaining: number; retryAfterMs: number };

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(readonly config: RateLimitConfig) {
    if (config.burst < 1 || config.perSecond <= 0) throw new RangeError('rate limit needs burst >= 1 and perSecond > 0');
  }

  /** Take one token for `key` at `now`; reports what is left, or how long until one is available. */
  take(key: string, now: number): Taken {
    const bucket = this.bucket(key, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(((1 - bucket.tokens) / this.config.perSecond) * 1000) };
  }

  /** The tokens `key` holds at `now` without spending one; a key never seen holds a full bucket. */
  available(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    return bucket === undefined ? this.config.burst : Math.floor(this.refilled(bucket, now));
  }

  get size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }

  /** The bucket for `key`, refilled to `now` and made the most recently used; a new one makes room first. */
  private bucket(key: string, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing === undefined) {
      if (this.buckets.size >= MAX_BUCKETS) this.evict(now);
      const bucket = { tokens: this.config.burst, updatedAt: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    existing.tokens = this.refilled(existing, now);
    existing.updatedAt = now;
    this.buckets.delete(key);
    this.buckets.set(key, existing);
    return existing;
  }

  private refilled(bucket: Bucket, now: number): number {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    return Math.min(this.config.burst, bucket.tokens + (elapsed / 1000) * this.config.perSecond);
  }

  /** Drop idle buckets, then the least recently used, until one more fits. */
  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.updatedAt > IDLE_MS) this.buckets.delete(key);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_BUCKETS) break;
      this.buckets.delete(key);
    }
  }
}

/** The peer's address as the Node server saw it; a request with no socket (a test, an in-process call) shares one bucket. */
export function remoteAddress(env: unknown): string {
  return (env as Partial<HttpBindings> | undefined)?.incoming?.socket.remoteAddress ?? 'unknown';
}

function limited(c: Context, buckets: TokenBuckets, taken: Taken): ApiFailure {
  const seconds = Math.max(1, Math.ceil(taken.retryAfterMs / 1000));
  c.header(RATE_LIMIT_LIMIT_HEADER, String(buckets.config.burst));
  c.header(RATE_LIMIT_REMAINING_HEADER, '0');
  c.header(RETRY_AFTER_HEADER, String(seconds));
  c.header(RATE_LIMIT_RESET_HEADER, String(seconds));
  return new ApiFailure(
    { type: 'rate_limited', code: 'too_many_requests', message: `Rate limit exceeded; retry in ${seconds}s`, detail: { retryAfterSeconds: seconds, limit: buckets.config.burst } },
    429,
  );
}

/**
 * Before authentication: an address whose failed attempts have spent its bucket is refused
 * outright, and a failure it lets through spends one more token. A request that
 * authenticates costs the address nothing. Hono renders an error where it is thrown, so by
 * the time `next()` returns the refusal is the response and `c.error` says what it was.
 */
export function limitAuthFailures(buckets: TokenBuckets, clock: () => number = Date.now): MiddlewareHandler {
  return async (c, next) => {
    const key = `address:${remoteAddress(c.env)}`;
    if (buckets.available(key, clock()) < 1) throw limited(c, buckets, buckets.take(key, clock()));
    await next();
    if (isAuthError(c.error) && c.error.apiType === 'authentication_error') buckets.take(key, clock());
  };
}

/** After authentication: the key's own bucket, reported in the `RateLimit-*` headers. */
export function rateLimit(buckets: TokenBuckets, clock: () => number = Date.now): MiddlewareHandler<AuthScope> {
  return async (c, next) => {
    const auth = c.get('auth') as AuthenticatedKey | undefined;
    const key = auth === undefined ? `address:${remoteAddress(c.env)}` : `key:${auth.key.id}`;
    const taken = buckets.take(key, clock());
    if (!taken.allowed) throw limited(c, buckets, taken);
    c.header(RATE_LIMIT_LIMIT_HEADER, String(buckets.config.burst));
    c.header(RATE_LIMIT_REMAINING_HEADER, String(taken.remaining));
    await next();
  };
}
