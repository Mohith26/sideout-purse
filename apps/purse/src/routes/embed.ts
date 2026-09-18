import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { EMBED_FLOWS, IDEMPOTENCY_KEY_HEADER, type EmbedUserState, type EntryResource } from '@purse/types';
import type { Id } from '@repo/ids';

import { consumeEmbedToken } from '../auth/embed-tokens';
import { AuthError } from '../auth/errors';
import { enterContest } from '../contests';
import type { Db } from '../db/client';
import { EmbedError } from '../embed/errors';
import { activeOrigins, allActiveOrigins, isOriginAllowed, normaliseOrigin } from '../embed/origins';
import { clearSessionCookie, issueSession, readSessionCookie, setSessionCookie, verifySession, type Session } from '../embed/session';
import { startSignin, verifySignin } from '../embed/signin';
import type { SmsSender } from '../embed/sms';
import { embedUserState, rewardsOf } from '../embed/state';
import { publishableAuth, type AuthScope } from '../http/auth';
import { parseBody, readBody } from '../http/body';
import { ok } from '../http/envelope';
import { idempotency, type IdempotencyScope } from '../http/idempotency';
import { limitAuthFailures, rateLimitByAddress, type TokenBuckets } from '../http/rate-limit';
import type { RequestScope } from '../http/request-id';
import type { Providers } from '../providers';
import type { ProcessKeys } from '../secrets';
import { startVerification } from '../users';
import { contestIdSchema, param } from './v1/schemas';
import { loadContestResource, participantResource, verificationResource } from './v1/serialize';

/**
 * The embed's own API, `/v1/embed/*` (spec 4.8), called by the frame the SDK mounts and,
 * for `GET /state`, headlessly by the partner's page. Every route takes a publishable key
 * (which names the tenant and is safe in a browser) and, where a user is involved, the
 * Purse session cookie; a session begins by redeeming an embed token (`POST /session`,
 * single use, five minutes, one user, one flow) or by phone and one-time code
 * (`/signin/*`). The middleware is applied per route so `POST /v1/embed/tokens`, the
 * secret-key route on the same prefix, falls through to the v1 stack untouched.
 *
 * Cross-origin: the frame is same-origin with this API, so its calls carry no `Origin`
 * header the API needs to answer; the headless read comes from the partner's page and
 * does. An `Origin` is answered with `Access-Control-Allow-Origin` only when the tenant
 * whose key was presented lists it (`tenant_origins`), and the preflight, which carries
 * no key, only when some tenant does. Rate limiting is by address: every visitor shares
 * the one publishable key.
 */
export type EmbedDeps = {
  db: Db;
  keys: ProcessKeys;
  providers: Providers;
  sms: SmsSender;
  buckets: TokenBuckets;
  trustedProxyHops: number;
  clock?: () => number;
  inProgressWaitMs?: number;
};

type SessionScope = { Variables: { session: Session | undefined } };
type EmbedScope = RequestScope & AuthScope & IdempotencyScope & SessionScope & { Variables: { body: Record<string, unknown> } };

const ALLOWED_HEADERS = `Authorization, Content-Type, ${IDEMPOTENCY_KEY_HEADER}, X-Request-Id`;
const EXPOSED_HEADERS = 'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, Retry-After, Idempotent-Replayed';

const sessionSchema = z.object({ embedToken: z.string().min(1).max(128), flow: z.enum(EMBED_FLOWS), parentOrigin: z.string().min(1).max(256) }).strict();
const signinStartSchema = z.object({ phoneE164: z.string().min(1).max(20) }).strict();
const signinVerifySchema = z.object({ phoneE164: z.string().min(1).max(20), code: z.string().min(1).max(12) }).strict();
const emptySchema = z.object({}).strict();

export function embedRoutes(deps: EmbedDeps) {
  const routes = new Hono<EmbedScope>();
  const now = (): Date => new Date(deps.clock === undefined ? Date.now() : deps.clock());

  /** The preflight: no key yet, so any origin some tenant lists is answered. */
  routes.options('/*', async (c) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && (await allActiveOrigins(deps.db)).includes(origin.toLowerCase())) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      c.header('Access-Control-Max-Age', '600');
      c.header('Vary', 'Origin');
    }
    return c.body(null, 204);
  });

  /** After the key: name the origin in the answer only if this tenant lists it. */
  const cors: MiddlewareHandler<EmbedScope> = async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && (await isOriginAllowed(deps.db, c.get('auth').tenant.id as Id<'tnt'>, origin))) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
      c.header('Vary', 'Origin');
    }
    await next();
  };

  const session: MiddlewareHandler<EmbedScope> = async (c, next) => {
    c.set('session', verifySession(deps.keys, readSessionCookie(c), c.get('auth').tenant.id as Id<'tnt'>, now()));
    await next();
  };

  const guard = [
    limitAuthFailures(deps.buckets, { db: deps.db, trustedProxyHops: deps.trustedProxyHops }, deps.clock),
    publishableAuth({ db: deps.db }),
    rateLimitByAddress(deps.buckets, { trustedProxyHops: deps.trustedProxyHops }, deps.clock),
    cors,
    readBody(),
    idempotency({ db: deps.db, ...(deps.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: deps.inProgressWaitMs }) }),
    session,
  ] as const;

  function requireSession(c: { get(key: 'session'): Session | undefined }): Session {
    const current = c.get('session');
    if (current === undefined) throw new EmbedError('session_required', 'Sign in to Purse first');
    return current;
  }

  routes.get('/origins', ...guard, async (c) => {
    return ok(c, { origins: await activeOrigins(c.get('db'), c.get('auth').tenant.id as Id<'tnt'>) });
  });

  routes.get('/state', ...guard, async (c) => {
    const current = c.get('session');
    const state: EmbedUserState = current === undefined ? { authenticated: false, user: null } : await embedUserState(c.get('db'), current.tenantId, current.userId);
    return ok(c, state);
  });

  routes.post('/session', ...guard, async (c) => {
    const auth = c.get('auth');
    const tenantId = auth.tenant.id as Id<'tnt'>;
    const body = parseBody(c, sessionSchema);
    const parent = normaliseOrigin(body.parentOrigin);
    if (!(await isOriginAllowed(c.get('db'), tenantId, parent))) {
      throw new EmbedError('origin_not_allowed', `${parent} is not an allowed origin for this tenant`, { origin: parent });
    }
    const token = await consumeEmbedToken(c.get('db'), { token: body.embedToken, flow: body.flow, now: now() });
    if (token.tenantId !== tenantId) {
      // A valid token of another tenant: consumed (single use holds), never honoured.
      throw new AuthError('embed_token_invalid', 'The embed token is not valid');
    }
    const issued = issueSession(deps.keys, { tenantId, userId: token.userId, now: now() });
    setSessionCookie(c, issued.token, issued.expiresAt);
    c.get('logger').info('embed session opened', { userId: token.userId, flow: token.flow, parentOrigin: parent });
    return ok(c, await embedUserState(c.get('db'), tenantId, token.userId), 201);
  });

  routes.post('/signin/start', ...guard, async (c) => {
    const body = parseBody(c, signinStartSchema);
    const started = await startSignin(c.get('db'), deps.keys, { tenantId: c.get('auth').tenant.id as Id<'tnt'>, phoneE164: body.phoneE164, sms: deps.sms, now: now(), requestId: c.get('requestId') });
    return ok(c, started);
  });

  routes.post('/signin/verify', ...guard, async (c) => {
    const tenantId = c.get('auth').tenant.id as Id<'tnt'>;
    const body = parseBody(c, signinVerifySchema);
    const user = await verifySignin(c.get('db'), deps.keys, { tenantId, phoneE164: body.phoneE164, code: body.code, now: now(), requestId: c.get('requestId') });
    const issued = issueSession(deps.keys, { tenantId, userId: user.id, now: now() });
    setSessionCookie(c, issued.token, issued.expiresAt);
    return ok(c, await embedUserState(c.get('db'), tenantId, user.id), 201);
  });

  routes.post('/signout', ...guard, async (c) => {
    parseBody(c, emptySchema);
    clearSessionCookie(c);
    const state: EmbedUserState = { authenticated: false, user: null };
    return ok(c, state);
  });

  routes.post('/identity/start', ...guard, async (c) => {
    const current = requireSession(c);
    parseBody(c, emptySchema);
    const started = await startVerification(c.get('db'), {
      tenantId: current.tenantId,
      userId: current.userId,
      identity: deps.providers.identity,
      actor: { kind: 'user', ref: current.userId },
      requestId: c.get('requestId'),
      issueToken: false,
    });
    return ok(c, { verification: verificationResource(started.verification), state: await embedUserState(c.get('db'), current.tenantId, current.userId) });
  });

  routes.get('/contests/:id', ...guard, async (c) => {
    requireSession(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    return ok(c, await loadContestResource(c.get('db'), c.get('auth').tenant.id as Id<'tnt'>, contestId));
  });

  routes.post('/contests/:id/entries', ...guard, async (c) => {
    const current = requireSession(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    parseBody(c, emptySchema);
    const entered = await enterContest(c.get('db'), {
      tenantId: current.tenantId,
      contestId,
      userId: current.userId,
      providers: { risk: deps.providers.risk },
      idempotencyKey: `embed:${c.get('idempotencyKey') ?? ''}`,
      actor: { kind: 'user', ref: current.userId },
      requestId: c.get('requestId'),
      now: now(),
    });
    const resource: EntryResource = {
      contest: await loadContestResource(c.get('db'), current.tenantId, contestId),
      participant: participantResource(entered.participant),
      eligibility: entered.eligibility,
      journalEntryId: entered.entry.entry.id,
    };
    return ok(c, resource, 201);
  });

  routes.get('/rewards', ...guard, async (c) => {
    const current = requireSession(c);
    return ok(c, { results: await rewardsOf(c.get('db'), current.tenantId, current.userId) });
  });

  return routes;
}
