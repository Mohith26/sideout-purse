/**
 * The address a request came from, for rate limiting.
 *
 * Route handlers see only a web `Request`, never the socket. Next's Node server sets
 * `X-Forwarded-For` from the socket when the header is absent, and every trusted proxy in
 * front of it appends the address it received from. With `TRUSTED_PROXY_HOPS = n`, the
 * client is the n-th entry from the end; with none, it is the last entry, which is the
 * socket address unless the caller sent the header themselves. That residual spoofability
 * in an unproxied deploy is why the global and per-phone limits exist alongside the
 * per-address one.
 */
export function clientAddress(headers: Headers, trustedProxyHops: number): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded === null) return 'unknown';
  const entries = forwarded
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return 'unknown';
  const index = Math.max(0, entries.length - Math.max(1, trustedProxyHops));
  return entries[index] ?? 'unknown';
}
