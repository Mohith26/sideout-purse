import { Hono } from 'hono';

import { bearerAuth } from '../../http/auth';
import { readBody } from '../../http/body';
import { idempotency } from '../../http/idempotency';
import { limitAuthFailures, rateLimit, type TokenBuckets } from '../../http/rate-limit';
import { contestsRoutes } from './contests';
import { embedRoutes } from './embed';
import { originsRoutes } from './origins';
import { paymentsRoutes, treasuryRoutes } from './payments';
import type { V1Deps, V1Scope } from './scope';
import { usersRoutes } from './users';
import { webhooksRoutes } from './webhooks';

/**
 * The public API (spec 4.7), mounted at `/v1`. The middleware stack, outermost first:
 *
 *   1. the failed-authentication limit, per address, so guessing is told to back off;
 *   2. bearer authentication, resolving the tenant and the actor from the secret key;
 *   3. rate limiting per key;
 *   4. the JSON body, read once;
 *   5. idempotency: on a mutation, the claim on the key and its stored response.
 *
 * Every request that reaches this stack needs a secret key. `GET /v1/health`,
 * `/v1/internal/*` and the embed's publishable-key routes (`/v1/embed/state` and the rest
 * of `src/routes/embed.ts`) are answered by the routes `app.ts` mounts before it, so they
 * never arrive here; any other method on those paths is refused like any unauthenticated
 * call. `POST /v1/embed/tokens` is a secret-key route and lives here.
 */
export type V1RouterDeps = V1Deps & { buckets: TokenBuckets; trustedProxyHops: number; clock?: () => number; inProgressWaitMs?: number };

export function v1Routes(deps: V1RouterDeps) {
  const v1 = new Hono<V1Scope>();
  v1.use('*', limitAuthFailures(deps.buckets, { db: deps.db, trustedProxyHops: deps.trustedProxyHops }, deps.clock));
  v1.use('*', bearerAuth({ db: deps.db }));
  v1.use('*', rateLimit(deps.buckets, deps.clock));
  v1.use('*', readBody());
  v1.use('*', idempotency({ db: deps.db, ...(deps.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: deps.inProgressWaitMs }) }));
  v1.route('/users', usersRoutes(deps));
  v1.route('/contests', contestsRoutes(deps));
  v1.route('/embed', embedRoutes(deps));
  v1.route('/webhooks', webhooksRoutes(deps));
  v1.route('/origins', originsRoutes(deps));
  // The fiat rail (spec 13.4). Same middleware stack as every other mutation, so a
  // deposit is idempotent the same way a contest entry is.
  v1.route('/payments', paymentsRoutes(deps));
  v1.route('/treasury', treasuryRoutes());
  return v1;
}
