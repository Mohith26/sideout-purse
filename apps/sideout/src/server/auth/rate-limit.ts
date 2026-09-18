/**
 * A sliding-window rate limiter over an in-memory store that is bounded in both time
 * and size: every key's hits older than the window are dropped on access, and when the
 * store holds `maxKeys` keys the least recently touched one is evicted. Memory is
 * therefore bounded by `maxKeys * limit` timestamps whatever a client does.
 *
 * Per-process only. That is the right scope for protecting the SMS budget of one
 * instance; a shared store is a deploy-time upgrade behind the same interface.
 */
export type Verdict = { allowed: boolean; retryAfterSeconds: number };

export type RateLimiter = {
  /** Whether a hit for `key` at `now` would be allowed, without recording one. */
  check(key: string, now: Date): Verdict;
  /** Record a hit for `key` at `now` if under the limit; report whether it was allowed. */
  hit(key: string, now: Date): Verdict;
  /** Number of keys currently held (for tests and the health of the bound). */
  size(): number;
};

export type RateLimitOptions = {
  /** Hits allowed per key within the window. */
  limit: number;
  windowMs: number;
  /** Upper bound on distinct keys held at once. */
  maxKeys: number;
};

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  // Insertion order doubles as recency: a touched key is deleted and re-set.
  const hits = new Map<string, number[]>();

  const refusal = (recent: number[], at: number): Verdict => {
    const oldest = recent[0] ?? at;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - at) / 1000)) };
  };

  return {
    check(key, now) {
      const at = now.getTime();
      const recent = (hits.get(key) ?? []).filter((t) => t > at - options.windowMs);
      return recent.length >= options.limit ? refusal(recent, at) : { allowed: true, retryAfterSeconds: 0 };
    },
    hit(key, now) {
      const at = now.getTime();
      const floor = at - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > floor);
      hits.delete(key);

      if (recent.length >= options.limit) {
        hits.set(key, recent);
        return refusal(recent, at);
      }

      recent.push(at);
      if (hits.size >= options.maxKeys) {
        const evict = hits.keys().next().value;
        if (evict !== undefined) hits.delete(evict);
      }
      hits.set(key, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    size: () => hits.size,
  };
}
