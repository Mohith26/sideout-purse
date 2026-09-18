import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq, sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, isIdempotencyKey, RETRY_AFTER_HEADER } from '@purse/types';
import type { Id } from '@repo/ids';
import { errorFields } from '@repo/logger';

import type { Db } from '../db/client';
import { idempotencyKeys, idempotencyReservations, type IdempotencyKeyRow } from '../db/schema';
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
 * A mutation runs in three short steps, and no connection or lock is held between them.
 * First the key is claimed: a replay is answered from the stored `http` row, otherwise a
 * reservation in `idempotency_reservations` names the request's hash and expires after
 * `RESERVATION_TTL_MS`. Then the handler runs against the pool (`c.get('db')`): every
 * service opens and commits its own transactions, so a provider called between two of
 * them (`startVerification`) holds no row lock and no pool connection while it waits on a
 * vendor, and a refused entry's decision record commits with the 403 that reported it.
 * Last, the response is stored as the key's `http` row. A crash between the claim and
 * the store leaves a reservation that expires, after which the key may be retried and the
 * request is performed then.
 *
 * A second request under a live reservation waits for the first to finish and is answered
 * with its stored response; one still waiting after `IN_PROGRESS_WAIT_MS` is refused with
 * `conflict` / `idempotency_key_in_progress` and `Retry-After`. The same key with a
 * different request, in flight or stored, is `idempotency_key_reused`.
 *
 * What is stored: every 2xx and every 4xx except 429, because a refusal is the answer to
 * that request. A 5xx and a 429 are not stored and release the reservation, so the partner
 * retries the same key and the request is performed then. A handler whose response carries
 * a secret returned once (`okOnce`) sets `replayBody`, and that is stored and replayed in
 * place of the response it sent. Rows are kept for at least 30 days and removed by
 * `pnpm --filter @purse/api db:purge`.
 *
 * Reads (GET, HEAD, OPTIONS) take no key.
 */
export type IdempotencyScope = { Variables: { db: Db; idempotencyKey: string | undefined; replayBody: unknown } };

type Scope = RequestScope & AuthScope & BodyScope & IdempotencyScope;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** How long a claim outlives a request that never stored its response. Longer than any handler, including a vendor call. */
export const RESERVATION_TTL_MS = 60_000;
/** How long a concurrent replay waits for the request in flight before it is told to retry. */
export const IN_PROGRESS_WAIT_MS = 5_000;
const POLL_MS = 50;

export type IdempotencyDeps = {
  db: Db;
  /** How long a concurrent replay waits before `idempotency_key_in_progress`; tests shorten it. */
  inProgressWaitMs?: number;
};

/** Hash of what makes a request "the same request": method, concrete path and body. */
export function httpRequestHash(method: string, path: string, body: unknown): string {
  return requestHash({ method, path, body });
}

export function storableStatus(status: number): boolean {
  return status < 500 && status !== 429;
}

type Claim = { kind: 'replay'; stored: IdempotencyKeyRow } | { kind: 'in_progress'; endpoint: string } | { kind: 'claimed'; reservedAt: Date };

function reused(key: string, endpoint: string): ApiFailure {
  return new ApiFailure({
    type: 'conflict',
    code: 'idempotency_key_reused',
    message: `${IDEMPOTENCY_KEY_HEADER} ${key} was already used for a different request`,
    detail: { idempotencyKey: key, endpoint },
  });
}

/** Answer from the stored row, or claim the key; a live claim by another request is `in_progress`. */
async function claim(db: Db, tenantId: Id<'tnt'>, key: string, hash: string, endpoint: string): Promise<Claim> {
  const [stored] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.scope, 'http'), eq(idempotencyKeys.key, key)));
  if (stored !== undefined) {
    if (stored.requestHash !== hash) throw reused(key, stored.operation);
    return { kind: 'replay', stored };
  }
  // Whole milliseconds: the instant round-trips through a Date and names this claim in `release`.
  const reservedAt = sql`date_trunc('milliseconds', now())`;
  const expiresAt = sql`now() + ${RESERVATION_TTL_MS / 1000}::float8 * interval '1 second'`;
  const [reserved] = await db
    .insert(idempotencyReservations)
    .values({ tenantId, key, operation: endpoint, requestHash: hash, reservedAt, expiresAt })
    .onConflictDoUpdate({
      target: [idempotencyReservations.tenantId, idempotencyReservations.key],
      set: { operation: endpoint, requestHash: hash, reservedAt, expiresAt },
      setWhere: sql`${idempotencyReservations.expiresAt} <= now()`,
    })
    .returning({ reservedAt: idempotencyReservations.reservedAt });
  if (reserved !== undefined) return { kind: 'claimed', reservedAt: reserved.reservedAt };
  const [live] = await db
    .select()
    .from(idempotencyReservations)
    .where(and(eq(idempotencyReservations.tenantId, tenantId), eq(idempotencyReservations.key, key)));
  if (live === undefined) throw new Error(`idempotency key ${key} could not be claimed and holds no reservation`);
  if (live.requestHash !== hash) throw reused(key, live.operation);
  return { kind: 'in_progress', endpoint: live.operation };
}

/** Expire the claim this request holds, so a retry may perform the request at once. Another request's newer claim is left alone. */
async function release(db: Db, tenantId: Id<'tnt'>, key: string, reservedAt: Date): Promise<void> {
  await db
    .update(idempotencyReservations)
    .set({ expiresAt: sql`now()` })
    .where(and(eq(idempotencyReservations.tenantId, tenantId), eq(idempotencyReservations.key, key), eq(idempotencyReservations.reservedAt, reservedAt)));
}

export function idempotency(deps: IdempotencyDeps): MiddlewareHandler<Scope> {
  const inProgressWaitMs = deps.inProgressWaitMs ?? IN_PROGRESS_WAIT_MS;
  return async (c, next) => {
    c.set('db', deps.db);
    c.set('replayBody', undefined);
    if (!MUTATING.has(c.req.method)) {
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

    const waitingSince = Date.now();
    let reservedAt: Date;
    for (;;) {
      const claimed = await claim(deps.db, tenantId, key, hash, endpoint);
      if (claimed.kind === 'replay') {
        logger.info('idempotent replay', { idempotencyKey: key, endpoint: claimed.stored.operation, status: claimed.stored.responseStatus });
        c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
        return c.json(claimed.stored.responseBody ?? {}, (claimed.stored.responseStatus ?? 200) as ContentfulStatusCode);
      }
      if (claimed.kind === 'claimed') {
        reservedAt = claimed.reservedAt;
        break;
      }
      if (Date.now() - waitingSince >= inProgressWaitMs) {
        c.header(RETRY_AFTER_HEADER, '1');
        throw new ApiFailure(
          {
            type: 'conflict',
            code: 'idempotency_key_in_progress',
            message: `A request with ${IDEMPOTENCY_KEY_HEADER} ${key} is still in progress; retry it to receive its response`,
            detail: { idempotencyKey: key, endpoint: claimed.endpoint },
          },
          409,
        );
      }
      await sleep(POLL_MS);
    }

    let produced: Response;
    try {
      await next();
      produced = c.res;
    } catch (error) {
      produced = renderError(c, logger, error);
    }
    if (!storableStatus(produced.status)) {
      await release(deps.db, tenantId, key, reservedAt);
      c.res = produced;
      return produced;
    }

    const body = (c.get('replayBody') ?? (await produced.clone().json())) as Record<string, unknown>;
    try {
      await deps.db
        .insert(idempotencyKeys)
        .values({ tenantId, scope: 'http', key, operation: endpoint, requestHash: hash, responseStatus: produced.status, responseBody: body })
        .onConflictDoNothing();
    } catch (error) {
      logger.error('idempotent response not stored; the request itself is committed', { idempotencyKey: key, endpoint, ...errorFields(error) });
    }
    c.res = produced;
    return produced;
  };
}
