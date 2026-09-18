import { Hono } from 'hono';
import { z } from 'zod';
import type { Id } from '@repo/ids';

import { activeOrigins, addOrigin, revokeOrigin } from '../../embed/origins';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import type { V1Deps, V1Scope } from './scope';

/**
 * `/v1/origins`, on the secret key: the tenant's embed origin allowlist (spec 4.8 rule 3).
 * A partner registers the origins of the pages that will mount Purse flows and revokes
 * the ones it retires; the seed registers Sideout's local origins so `pnpm dev` works
 * with no step. The frame, the session endpoint and CORS all read this list.
 */
const originSchema = z.object({ origin: z.string().min(1).max(256) }).strict();

export function originsRoutes(_deps: V1Deps) {
  const routes = new Hono<V1Scope>();

  routes.get('/', async (c) => {
    return ok(c, { origins: await activeOrigins(c.get('db'), c.get('auth').tenant.id as Id<'tnt'>) });
  });

  routes.post('/', async (c) => {
    const auth = c.get('auth');
    const body = parseBody(c, originSchema);
    const added = await addOrigin(c.get('db'), { tenantId: auth.tenant.id as Id<'tnt'>, origin: body.origin, actor: auth.actor, requestId: c.get('requestId') });
    return ok(c, { origin: added.origin, origins: await activeOrigins(c.get('db'), auth.tenant.id as Id<'tnt'>) }, 201);
  });

  routes.post('/revoke', async (c) => {
    const auth = c.get('auth');
    const body = parseBody(c, originSchema);
    await revokeOrigin(c.get('db'), { tenantId: auth.tenant.id as Id<'tnt'>, origin: body.origin, actor: auth.actor, requestId: c.get('requestId') });
    return ok(c, { origins: await activeOrigins(c.get('db'), auth.tenant.id as Id<'tnt'>) });
  });

  return routes;
}
