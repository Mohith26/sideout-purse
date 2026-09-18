import { Hono } from 'hono';
import type { Sql } from '@repo/db';
import type { Logger } from '@repo/logger';

import type { Db } from './db/client';
import type { SmsSender } from './embed/sms';
import { fail } from './http/envelope';
import { renderError } from './http/errors';
import { DEFAULT_RATE_LIMIT, TokenBuckets, type RateLimitConfig } from './http/rate-limit';
import { requestId, type RequestScope } from './http/request-id';
import type { Providers } from './providers';
import { consoleRoutes } from './routes/console';
import { embedRoutes } from './routes/embed';
import { embedStaticRoutes } from './routes/embed-static';
import { healthRoutes } from './routes/health';
import { internalRoutes } from './routes/internal';
import { v1Routes } from './routes/v1';
import type { ProcessKeys } from './secrets';

export type AppDeps = {
  sql: Sql;
  db: Db;
  logger: Logger;
  migrationsFolder: string;
  sha: string;
  nodeEnv: 'development' | 'test' | 'production';
  internalApiToken: string | undefined;
  providers: Providers;
  /** The derived process keys (`src/secrets.ts`): sessions, sign-in codes, webhook secrets. */
  keys: ProcessKeys;
  /** The embed sign-in's SMS seam. */
  sms: SmsSender;
  /** Where the built embed app is served from under `/embed`; `undefined` looks for the sibling app's export. */
  embedDir?: string | undefined;
  rateLimit?: RateLimitConfig;
  /** Proxies whose `X-Forwarded-For` entry names the client (`TRUSTED_PROXY_HOPS`); defaults to none. */
  trustedProxyHops?: number;
  /** The rate limiter's clock, for tests. */
  clock?: () => number;
  /** How long a replay waits for a request in flight under its key, for tests. */
  inProgressWaitMs?: number;
};

/**
 * Build the HTTP app from its dependencies. `index.ts` wires the real ones; tests pass a
 * test database, dev providers and a capturing logger.
 *
 * `/health` and `/internal/*` answer at the root and under `/v1` (spec 4.7 lists them
 * with the versioned base). They are registered before the `/v1` router, so its
 * authentication never sees a `GET` to them; so are the embed's publishable-key routes
 * (`/v1/embed/state` and the rest of `routes/embed.ts`) and the embed app itself under
 * `/embed`. Every other request under `/v1` needs a secret key. The operator console's API
 * is `/console/*` (`routes/console`), behind the console's own session, never a key.
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
  const embedStatic = embedStaticRoutes({ db: deps.db, dir: deps.embedDir });
  app.route('/', health);
  app.route('/', internal);
  app.route('/', embedStatic.routes);
  app.route('/v1', health);
  app.route('/v1', internal);
  app.route(
    '/console',
    consoleRoutes({
      db: deps.db,
      keys: deps.keys,
      providers: deps.providers,
      trustedProxyHops: deps.trustedProxyHops ?? 0,
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: deps.inProgressWaitMs }),
    }),
  );
  app.route(
    '/v1/embed',
    embedRoutes({
      db: deps.db,
      keys: deps.keys,
      providers: deps.providers,
      sms: deps.sms,
      buckets,
      trustedProxyHops: deps.trustedProxyHops ?? 0,
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: deps.inProgressWaitMs }),
    }),
  );
  app.route(
    '/v1',
    v1Routes({
      db: deps.db,
      providers: deps.providers,
      keys: deps.keys,
      buckets,
      trustedProxyHops: deps.trustedProxyHops ?? 0,
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: deps.inProgressWaitMs }),
    }),
  );

  return { app, buckets, embedDir: embedStatic.dir };
}

export type App = ReturnType<typeof createApp>['app'];

