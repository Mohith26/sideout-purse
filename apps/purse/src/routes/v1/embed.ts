import { Hono } from 'hono';
import { z } from 'zod';
import { EMBED_FLOWS } from '@purse/types';
import type { Id } from '@repo/ids';

import { issueEmbedToken } from '../../auth/embed-tokens';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import { getUser } from '../../users';
import type { V1Deps, V1Scope } from './scope';
import { param, userIdSchema } from './schemas';
import { embedTokenResource } from './serialize';

/**
 * `POST /v1/embed/tokens` (spec 4.7, 4.8): a short-lived, single-use token for one user
 * and one iframe flow, minted server-to-server and handed to the browser, where phase 4's
 * SDK opens the flow with it. The identity flow's token is also minted by
 * `POST /users/:id/verification`, which is the usual way to start that one.
 */
const tokenSchema = z.object({ userId: userIdSchema, flow: z.enum(EMBED_FLOWS) }).strict();

export function embedRoutes(_deps: V1Deps) {
  const routes = new Hono<V1Scope>();

  routes.post('/tokens', async (c) => {
    const auth = c.get('auth');
    const body = parseBody(c, tokenSchema);
    const user = await getUser(c.get('db'), auth.tenant.id as Id<'tnt'>, param(userIdSchema, 'userId', body.userId));
    const issued = await issueEmbedToken(c.get('db'), { tenantId: auth.tenant.id as Id<'tnt'>, userId: user.id, flow: body.flow });
    return ok(c, embedTokenResource(issued), 201);
  });

  return routes;
}
