import { Hono } from 'hono';

import { bearerAuth } from '../../http/auth';
import { readBody } from '../../http/body';
import { idempotency } from '../../http/idempotency';
import { rateLimit, type TokenBuckets } from '../../http/rate-limit';
import { contestsRoutes } from './contests';
import { embedRoutes } from './embed';
import type { V1Deps, V1Scope } from './scope';
import { usersRoutes } from './users';

/**
 * The public API (spec 4.7), mounted at `/v1`. The middleware stack, outermost first:
 *
 *   1. rate limiting per key prefix (before authentication, so guessing is throttled too);
 *   2. bearer authentication, resolving the tenant and the actor from the secret key;
 *   3. the JSON body, read once;
 *   4. idempotency: on a mutation, the request's transaction and its stored response.
 *
 * `/v1/health` and `/v1/internal/*` are mounted by `app.ts` outside this stack: the first
 * is public and the second is gated by its own token, not by an API key.
 */
export const PUBLIC_V1_PATHS: ReadonlySet<string> = new Set(['/v1/health']);

export function isPublicV1Path(path: string): boolean {
  return PUBLIC_V1_PATHS.has(path) || path.startsWith('/v1/internal/');
}

export type V1RouterDeps = V1Deps & { buckets: TokenBuckets; clock?: () => number };

export function v1Routes(deps: V1RouterDeps) {
  const v1 = new Hono<V1Scope>();
  v1.use('*', rateLimit(deps.buckets, deps.clock));
  v1.use('*', bearerAuth({ db: deps.db, isPublic: isPublicV1Path }));
  v1.use('*', readBody());
  v1.use('*', idempotency({ db: deps.db }));
  v1.route('/users', usersRoutes(deps));
  v1.route('/contests', contestsRoutes(deps));
  v1.route('/embed', embedRoutes(deps));
  return v1;
}
