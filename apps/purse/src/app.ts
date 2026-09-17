import { Hono } from 'hono';
import type { Sql } from '@repo/db';

import { ApiFailure, fail } from './http/envelope';
import { requestId, type RequestScope } from './http/request-id';
import { errorFields, type Logger } from './logger';
import { healthRoutes } from './routes/health';

export type AppDeps = {
  sql: Sql;
  logger: Logger;
  migrationsFolder: string;
  sha: string;
};

/**
 * Build the HTTP app from its dependencies. `index.ts` wires the real ones; tests pass a
 * test database and a capturing logger.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<RequestScope>();

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

  app.onError((error, c) => {
    if (error instanceof ApiFailure) {
      return fail(c, error.error, error.status);
    }
    c.get('logger').error('unhandled error', errorFields(error));
    return fail(c, { type: 'internal_error', code: 'unhandled', message: 'Something went wrong' });
  });

  app.route('/', healthRoutes({ sql: deps.sql, migrationsFolder: deps.migrationsFolder, sha: deps.sha }));

  return app;
}

export type App = ReturnType<typeof createApp>;
