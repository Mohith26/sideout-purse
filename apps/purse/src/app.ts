import { Hono } from 'hono';
import type { Sql } from '@repo/db';
import type { Logger } from '@repo/logger';

import type { Db } from './db/client';
import { fail } from './http/envelope';
import { renderError } from './http/errors';
import { DEFAULT_RATE_LIMIT, TokenBuckets, type RateLimitConfig } from './http/rate-limit';
import { requestId, type RequestScope } from './http/request-id';
import type { Providers } from './providers';
import { healthRoutes } from './routes/health';
import { internalRoutes } from './routes/internal';
import { v1Routes } from './routes/v1';

export type AppDeps = {
  sql: Sql;
  db: Db;
  logger: Logger;
  migrationsFolder: string;
  sha: string;
  nodeEnv: 'development' | 'test' | 'production';
  internalApiToken: string | undefined;
  providers: Providers;
  rateLimit?: RateLimitConfig;
  /** The rate limiter's clock, for tests. */
  clock?: () => number;
};

/**
 * Build the HTTP app from its dependencies. `index.ts` wires the real ones; tests pass a
 * test database, dev providers and a capturing logger.
 *
 * `/health` and `/internal/reconcile` answer at the root and under `/v1` (spec 4.7 lists
 * them with the versioned base). They are registered before the `/v1` router, so its
 * authentication never sees them; the router also names them public.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<RequestScope>();
  const buckets = new TokenBuckets(deps.rateLimit ?? DEFAULT_RATE_LIMIT);

  app.use(requestId(deps.logger));

  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    c.get('logger').info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  app.notFound((c) =>
    fail(c, { type: 'invalid_request', code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` }, 404),
  );

  app.onError((error, c) => renderError(c, c.get('logger'), error));

  const health = healthRoutes({ sql: deps.sql, db: deps.db, migrationsFolder: deps.migrationsFolder, sha: deps.sha });
  const internal = internalRoutes({ db: deps.db, internalApiToken: deps.internalApiToken, nodeEnv: deps.nodeEnv });
  app.route('/', health);
  app.route('/', internal);
  app.route('/v1', health);
  app.route('/v1', internal);
  app.route('/v1', v1Routes({ db: deps.db, providers: deps.providers, buckets, ...(deps.clock === undefined ? {} : { clock: deps.clock }) }));

  return { app, buckets };
}

export type App = ReturnType<typeof createApp>['app'];

