import type { MiddlewareHandler } from 'hono';

import { authenticateApiKey, type AuthenticatedKey } from '../auth/api-keys';
import { AuthError } from '../auth/errors';
import type { DbOrTx } from '../db/client';
import type { RequestScope } from './request-id';

/**
 * Bearer authentication for `/v1` (spec 4.7): `Authorization: Bearer sk_...`. The secret
 * key resolves the tenant and the actor every write is recorded under. A publishable key
 * is refused here without a lookup: it only bootstraps the iframe (the phase 4 route
 * consumes it elsewhere), and never a server-to-server call.
 */
export type AuthScope = { Variables: { auth: AuthenticatedKey } };

export type BearerAuthDeps = {
  db: DbOrTx;
  /** Paths served without a key: `/v1/health`, and the internal routes with their own token. */
  isPublic?: (path: string) => boolean;
};

export function presentedToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

export function bearerAuth(deps: BearerAuthDeps): MiddlewareHandler<RequestScope & AuthScope> {
  return async (c, next) => {
    if (deps.isPublic?.(c.req.path) === true) {
      await next();
      return;
    }
    const token = presentedToken(c.req.header('Authorization'));
    if (token === undefined) {
      throw new AuthError('missing_api_key', 'Authorization: Bearer <secret key> is required');
    }
    if (token.startsWith('pk_')) {
      throw new AuthError('secret_key_required', 'A publishable key cannot call the API; use the secret key from a server');
    }
    const auth = await authenticateApiKey(deps.db, token);
    if (auth.key.kind !== 'secret') {
      throw new AuthError('secret_key_required', 'A secret key is required');
    }
    c.set('auth', auth);
    c.set('logger', c.get('logger').child({ tenantId: auth.tenant.id, apiKeyId: auth.key.id, environment: auth.key.environment }));
    await next();
  };
}

/** Routes an operator-scoped key may call (`POST /users/:id/credits`; docs/decisions.md). */
export function requireOperator(): MiddlewareHandler<AuthScope> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth.key.scopes.includes('operator')) {
      throw new AuthError('operator_scope_required', 'This route needs a secret key with the operator scope', { keyPrefix: auth.key.keyPrefix });
    }
    await next();
  };
}
