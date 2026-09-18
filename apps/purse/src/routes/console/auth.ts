import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { ConsoleMeResource, ConsoleSessionResource, OperatorResource } from '@purse/types';

import type { Operator } from '../../db/schema';
import { presentedToken } from '../../http/auth';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import { clientAddress, limited, TokenBuckets, type RateLimitConfig } from '../../http/rate-limit';
import type { RequestScope } from '../../http/request-id';
import { authenticateSession, isOperatorError, OperatorError, operatorActor, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, revokeOtherSessions, revokeSession, setPassword, signIn } from '../../operators';
import type { ConsoleDeps, ConsoleScope, OperatorScope } from './scope';

/**
 * The console's own authentication (spec 4.10). `POST /console/auth/login` takes an email
 * and a password and answers with a session token the console app keeps in an HttpOnly
 * cookie on its own origin; every other console route takes that token as
 * `Authorization: Bearer cst_...`. Sign-in failures are charged to the caller's address:
 * ten at once, then one every thirty seconds, so a password cannot be guessed at speed
 * (`SIGN_IN_LIMIT`). A request that signs in is never refused on its address.
 */
export const SIGN_IN_LIMIT: RateLimitConfig = { burst: 10, perSecond: 1 / 30 };

const loginSchema = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }).strict();

const passwordSchema = z
  .object({ currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH), newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH) })
  .strict();

const emptySchema = z.object({}).strict();

export function operatorResource(operator: Operator): OperatorResource {
  return { id: operator.id, email: operator.email, role: operator.role, createdAt: operator.createdAt.toISOString() };
}

/** Bearer session authentication for every console route but sign-in. */
export function operatorAuth(deps: Pick<ConsoleDeps, 'db' | 'clock'>): MiddlewareHandler<RequestScope & OperatorScope> {
  return async (c, next) => {
    const token = presentedToken(c.req.header('Authorization'));
    const { operator, session } = await authenticateSession(deps.db, token, new Date(deps.clock?.() ?? Date.now()));
    c.set('operator', operator);
    c.set('session', session);
    c.set('actor', operatorActor(operator));
    c.set('logger', c.get('logger').child({ operatorId: operator.id, operatorRole: operator.role }));
    await next();
  };
}

/** Routes only an `admin` may call: tenant status, API keys, ruleset changes (docs/decisions.md, phase 5). */
export function requireAdmin(): MiddlewareHandler<OperatorScope> {
  return async (c, next) => {
    const operator = c.get('operator');
    if (operator.role !== 'admin') {
      throw new OperatorError('admin_required', 'This action needs the admin role', { operatorId: operator.id, role: operator.role });
    }
    await next();
  };
}

/** `POST /console/auth/login`: the one console route that takes no session. Mounted before the authenticated stack. */
export function signInRoutes(deps: Pick<ConsoleDeps, 'db' | 'trustedProxyHops' | 'clock'>) {
  const routes = new Hono<RequestScope>();
  const buckets = new TokenBuckets(SIGN_IN_LIMIT);
  const clock = deps.clock ?? Date.now;

  routes.post('/login', async (c) => {
    const address = `console-login:${clientAddress(c, { trustedProxyHops: deps.trustedProxyHops })}`;
    if (buckets.available(address, clock()) < 1) throw limited(c, buckets, buckets.take(address, clock()));
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) throw new OperatorError('invalid_credentials', 'Email or password is wrong');
    try {
      const signedIn = await signIn(deps.db, { email: parsed.data.email, password: parsed.data.password, now: new Date(clock()), requestId: c.get('requestId') });
      c.get('logger').info('operator signed in', { operatorId: signedIn.operator.id, sessionId: signedIn.session.id });
      const body: ConsoleSessionResource = {
        operator: operatorResource(signedIn.operator),
        sessionId: signedIn.session.id,
        token: signedIn.token,
        expiresAt: signedIn.session.expiresAt.toISOString(),
      };
      return ok(c, body, 201);
    } catch (error) {
      if (isOperatorError(error) && error.apiType === 'authentication_error') {
        const taken = buckets.take(address, clock());
        if (!taken.allowed) throw limited(c, buckets, taken);
      }
      throw error;
    }
  });

  return routes;
}

/** `/console/auth/*` behind the session: who am I, sign out, change my password. */
export function sessionRoutes(deps: Pick<ConsoleDeps, 'db'>) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/me', (c) => {
    const session = c.get('session');
    const body: ConsoleMeResource = { operator: operatorResource(c.get('operator')), sessionId: session.id, expiresAt: session.expiresAt.toISOString() };
    return ok(c, body);
  });

  routes.post('/logout', async (c) => {
    parseBody(c, emptySchema);
    const session = c.get('session');
    await revokeSession(c.get('db'), { sessionId: session.id, operator: c.get('operator'), requestId: c.get('requestId') });
    return ok(c, { signedOut: true, sessionId: session.id });
  });

  routes.post('/password', async (c) => {
    const body = parseBody(c, passwordSchema);
    const operator = c.get('operator');
    const session = c.get('session');
    await setPassword(deps.db, { operatorId: operator.id, currentPassword: body.currentPassword, newPassword: body.newPassword, actor: c.get('actor'), requestId: c.get('requestId') });
    const revoked = await revokeOtherSessions(deps.db, operator.id, session.id);
    c.get('logger').info('operator password changed', { operatorId: operator.id, otherSessionsRevoked: revoked });
    return ok(c, { changed: true, otherSessionsRevoked: revoked });
  });

  return routes;
}
