import { and, eq, sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, isIdempotencyKey } from '@purse/types';
import type { Id } from '@repo/ids';

import type { Db, DbOrTx } from '../db/client';
import { idempotencyKeys } from '../db/schema';
import { requestHash } from '../ledger/hash';
import type { AuthScope } from './auth';
import type { BodyScope } from './body';
import { ApiFailure } from './envelope';
import { renderError } from './errors';
import type { RequestScope } from './request-id';

/**
 * `Idempotency-Key` on every mutation (spec section 2 rule 4, 4.7): the first response
 * under a key is stored and every replay is answered with it, unchanged, creating nothing
 * new; the same key with a different request is a `conflict`.
 *
 * The middleware owns one database transaction for the whole request. Handlers reach it
 * as `c.get('db')`, so every service transaction they open becomes a savepoint inside it,
 * and the stored response row commits with the request's effects or not at all: a crash
 * between the two is impossible, and a refused entry's decision record (written after its
 * savepoint rolled back) commits with the 403 that reported it. An advisory lock on the
 * key serialises concurrent replays, so the second waits and then reads the first's row.
 *
 * What is stored: every 2xx and every 4xx except 429, because a refusal is the answer to
 * that request. A 5xx, a 429 and a failed commit are not stored and roll everything back,
 * so the partner retries the same key and the request is performed then. Rows are kept
 * for at least 30 days and removed by `pnpm --filter @purse/api purge`.
 *
 * Reads (GET, HEAD, OPTIONS) take no key and see the pool directly.
 */
export type IdempotencyScope = { Variables: { db: DbOrTx; idempotencyKey: string | undefined } };

type Scope = RequestScope & AuthScope & BodyScope & IdempotencyScope;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Thrown inside the transaction to roll it back while keeping the response that explains why. */
class RollbackWithResponse extends Error {
  override readonly name = 'RollbackWithResponse';
  constructor(readonly response: Response) {
    super('rollback');
  }
}

export type IdempotencyDeps = { db: Db };

/** Hash of what makes a request "the same request": method, concrete path and body. */
export function httpRequestHash(method: string, path: string, body: unknown): string {
  return requestHash({ method, path, body });
}

export function storableStatus(status: number): boolean {
  return status < 500 && status !== 429;
}

export function idempotency(deps: IdempotencyDeps): MiddlewareHandler<Scope> {
  return async (c, next) => {
    if (!MUTATING.has(c.req.method)) {
      c.set('db', deps.db);
      c.set('idempotencyKey', undefined);
      await next();
      return;
    }

    const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined || key.trim() === '') {
      throw new ApiFailure({ type: 'invalid_request', code: 'missing_idempotency_key', message: `${IDEMPOTENCY_KEY_HEADER} is required on ${c.req.method} requests` });
    }
    if (!isIdempotencyKey(key)) {
      throw new ApiFailure({ type: 'invalid_request', code: 'invalid_idempotency_key', message: `${IDEMPOTENCY_KEY_HEADER} must be 1 to 200 characters with no whitespace or control characters` });
    }
    c.set('idempotencyKey', key);

    const tenantId = c.get('auth').tenant.id as Id<'tnt'>;
    const logger = c.get('logger');
    const endpoint = `${c.req.method} ${c.req.matchedRoutes.at(-1)?.path ?? c.req.path}`;
    const hash = httpRequestHash(c.req.method, c.req.path, c.get('body'));

    let response: Response;
    try {
      response = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`idem:http:${tenantId}:${key}`}, 0))`);
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.scope, 'http'), eq(idempotencyKeys.key, key)));

        if (existing !== undefined) {
          if (existing.requestHash !== hash) {
            throw new ApiFailure({
              type: 'conflict',
              code: 'idempotency_key_reused',
              message: `${IDEMPOTENCY_KEY_HEADER} ${key} was already used for a different request`,
              detail: { idempotencyKey: key, endpoint: existing.operation },
            });
          }
          logger.info('idempotent replay', { idempotencyKey: key, endpoint: existing.operation, status: existing.responseStatus });
          c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
          return c.json(existing.responseBody ?? {}, (existing.responseStatus ?? 200) as ContentfulStatusCode);
        }

        c.set('db', tx);
        let produced: Response;
        try {
          await next();
          produced = c.res;
        } catch (error) {
          produced = renderError(c, logger, error);
        }
        if (!storableStatus(produced.status)) throw new RollbackWithResponse(produced);

        const body = (await produced.clone().json()) as Record<string, unknown>;
        await tx.insert(idempotencyKeys).values({
          tenantId,
          scope: 'http',
          key,
          operation: endpoint,
          requestHash: hash,
          responseStatus: produced.status,
          responseBody: body,
        });
        return produced;
      });
    } catch (error) {
      if (error instanceof RollbackWithResponse) {
        response = error.response;
      } else if (error instanceof ApiFailure) {
        throw error;
      } else {
        // The transaction itself failed (a deferred constraint at commit, a lost
        // connection): whatever the handler answered is void, and nothing was stored.
        response = renderError(c, logger, error);
      }
    }
    c.res = response;
    return response;
  };
}
