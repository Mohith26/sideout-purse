import { existsSync } from 'node:fs';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import type { Db } from '../db/client';
import { allActiveOrigins } from '../embed/origins';
import { fail } from '../http/envelope';
import type { RequestScope } from '../http/request-id';
import { APP_ROOT } from '../paths';

/**
 * The embed app (`apps/purse-embed`) is a static export served by this process under
 * `/embed`, so the frame the SDK mounts is on the Purse origin (spec 4.8 rule 1) and its
 * calls to `/v1/embed/*` are same-origin. `PURSE_EMBED_DIR` names the export; the default
 * is the sibling app's `out` directory. When neither exists (an API-only process, or a
 * checkout that has not built the embed) `/embed/*` answers 404 with a hint rather than
 * an empty page.
 *
 * Headers on every embed response: `frame-ancestors` is the union of every tenant's
 * active origins, refreshed every `ORIGINS_TTL_MS`, so a page that is not a partner's
 * cannot even frame the flow, let alone talk to it; the HTML is never cached, while
 * Next's hashed assets are immutable.
 */
export const DEFAULT_EMBED_DIR = path.resolve(APP_ROOT, '..', 'purse-embed', 'out');
const ORIGINS_TTL_MS = 30_000;

export type EmbedStaticDeps = { db: Db; dir: string | undefined };

export function resolveEmbedDir(configured: string | undefined): string | undefined {
  const dir = configured ?? DEFAULT_EMBED_DIR;
  return existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

export function embedStaticRoutes(deps: EmbedStaticDeps) {
  const routes = new Hono<RequestScope>();
  const dir = resolveEmbedDir(deps.dir);

  let ancestors: { value: string; at: number } | undefined;
  async function frameAncestors(): Promise<string> {
    const now = Date.now();
    if (ancestors !== undefined && now - ancestors.at < ORIGINS_TTL_MS) return ancestors.value;
    const origins = await allActiveOrigins(deps.db);
    ancestors = { value: ['\'self\'', ...origins].join(' '), at: now };
    return ancestors.value;
  }

  routes.get('/embed', (c) => c.redirect('/embed/', 301));

  if (dir === undefined) {
    routes.all('/embed/*', (c) =>
      fail(c, { type: 'invalid_request', code: 'embed_not_built', message: 'The embed app is not built; run `pnpm --filter @purse/embed build` or set PURSE_EMBED_DIR' }, 404),
    );
    return { routes, dir };
  }

  routes.use('/embed/*', async (c, next) => {
    c.header('Content-Security-Policy', `frame-ancestors ${await frameAncestors()}`);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Cache-Control', c.req.path.startsWith('/embed/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store');
    await next();
  });
  routes.use('/embed/*', serveStatic({ root: dir, rewriteRequestPath: (requestPath) => requestPath.replace(/^\/embed\/?/, '/') }));
  routes.all('/embed/*', (c) => fail(c, { type: 'invalid_request', code: 'not_found', message: `No embed file at ${c.req.path}` }, 404));
  return { routes, dir };
}
