/**
 * A sliding-window rate limiter over an in-memory store that is bounded in both time
 * and size: every key's hits older than the window are dropped on access, and when the
 * store holds `maxKeys` keys the least recently touched one is evicted. Memory is
 * therefore bounded by `maxKeys * limit` timestamps whatever a client does.
 *
 * Per-process only. That is the right scope for protecting the SMS budget of one
 * instance; a shared store is a deploy-time upgrade behind the same interface.
 */
export type RateLimiter = {
  /** Record a hit for `key` at `now` if under the limit; report whether it was allowed. */
  hit(key: string, now: Date): { allowed: boolean; retryAfterSeconds: number };
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

  return {
    hit(key, now) {
      const at = now.getTime();
      const floor = at - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > floor);
      hits.delete(key);

      if (recent.length >= options.limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? at;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - at) / 1000)) };
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
