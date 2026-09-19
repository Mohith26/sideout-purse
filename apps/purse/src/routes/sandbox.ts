import { Hono } from 'hono';
import { z } from 'zod';
import { IDEMPOTENT_REPLAYED_HEADER, isIdempotencyKey } from '@purse/types';

import type { Db } from '../db/client';
import { parseBody, readBody, type BodyScope } from '../http/body';
import { ApiFailure, ok } from '../http/envelope';
import { clientAddress, limited, rateLimitByAddress, TokenBuckets } from '../http/rate-limit';
import type { RequestScope } from '../http/request-id';
import { mintSandbox } from '../sandbox/mint';

/** Host comes from the request, never an arbitrary Origin; trusted proxies may terminate TLS. */
export function docsOrigin(c: { req: { url: string; header(name: string): string | undefined } }, trustedProxyHops: number): string {
  const url = new URL(c.req.url);
  if (trustedProxyHops > 0) {
    const proto = c.req.header('x-forwarded-proto')?.split(',').at(-trustedProxyHops)?.trim();
    if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  }
  return url.origin;
}

export function sandboxRoutes(deps: { db: Db; enabled: boolean; trustedProxyHops: number; clock?: () => number }) {
  const routes = new Hono<RequestScope & BodyScope>();
  const clock = deps.clock ?? Date.now;
  const addresses = new TokenBuckets({ burst: 3, perSecond: 1 / 3600 });
  const processWide = new TokenBuckets({ burst: 10, perSecond: 1 / 60 });
  routes.post('/keys', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.enabled) throw new ApiFailure({ type: 'permission_error', code: 'sandbox_disabled', message: 'Self-serve sandbox minting is disabled on this host' });
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== docsOrigin(c, deps.trustedProxyHops)) {
      throw new ApiFailure({ type: 'permission_error', code: 'origin_not_allowed', message: 'Mint a sandbox from this API’s docs page' });
    }
    const taken = processWide.take('sandbox', clock());
    if (!taken.allowed) throw limited(c, processWide, taken);
    await next();
  }, rateLimitByAddress(addresses, deps, clock), readBody(), async (c) => {
    parseBody(c, z.object({}).strict());
    const requestKey = c.req.header('Idempotency-Key');
    if (requestKey === undefined || !isIdempotencyKey(requestKey)) {
      throw new ApiFailure({ type: 'invalid_request', code: 'invalid_idempotency_key', message: 'A valid Idempotency-Key is required to mint a sandbox' });
    }
    const keys = await mintSandbox(deps.db, {
      address: clientAddress(c, deps), requestKey, origin: docsOrigin(c, deps.trustedProxyHops), now: new Date(clock()),
    });
    if (keys.replayed) c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return ok(c, keys, 201);
  });
  return routes;
}
