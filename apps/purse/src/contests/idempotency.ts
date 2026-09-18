import { and, eq, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { idempotencyKeys } from '../db/schema';
import { requestHash } from '../ledger/hash';
import { validateIdempotencyKey } from '../ledger/validate';
import { ContestError } from './errors';

/**
 * Spec section 2, rule 4: every mutation takes an idempotency key, and replaying it
 * returns the original result and creates nothing new. The journal already does this for
 * anything that is an entry; this does it for the contest mutations, which may create
 * several rows or, on an empty contest, no journal entry at all.
 *
 * One row per (tenant, key) in `idempotency_keys` records the operation, a hash of the
 * request and a small JSON `record` of the ids the operation produced. A replay with the
 * same request reloads the result from those ids; a different request under a used key is
 * a conflict; two concurrent calls under one key serialise on an advisory lock so the
 * second sees the first's row. Everything happens inside the caller's transaction, so the
 * record commits with the effects it describes or not at all.
 *
 * The request key is at most 200 characters so the ledger keys derived from it
 * (`contest-entry:<key>`, ...) stay inside the journal's 255.
 */
export const REQUEST_KEY_MAX = 200;

export type IdempotencyScope = {
  tenantId: Id<'tnt'>;
  key: string;
  /** `contest.create`, `contest.enter`, ...: part of the request identity, so one key cannot serve two operations. */
  operation: string;
  /** What makes this request "the same request": everything the caller chose, nothing the platform derives. */
  request: unknown;
};

export type Replayable<T, R extends Record<string, unknown>> = {
  /** Perform the operation; `record` is what a replay needs to rebuild `value`. */
  run(): Promise<{ value: T; record: R }>;
  /** Rebuild the original result from a stored record. */
  replay(record: R): Promise<T>;
};

export type IdempotentResult<T> = { value: T; replayed: boolean };

export async function idempotent<T, R extends Record<string, unknown>>(
  tx: DbOrTx,
  scope: IdempotencyScope,
  ops: Replayable<T, R>,
): Promise<IdempotentResult<T>> {
  validateRequestKey(scope.key);
  const hash = requestHash({ operation: scope.operation, request: scope.request });

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`idem:${scope.tenantId}:${scope.key}`}, 0))`);

  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, scope.tenantId), eq(idempotencyKeys.key, scope.key)));
  if (existing !== undefined) {
    if (existing.requestHash !== hash) {
      throw new ContestError('idempotency_conflict', `idempotency key ${scope.key} was already used for a different request`, {
        idempotencyKey: scope.key,
        operation: existing.operation,
      });
    }
    return { value: await ops.replay(existing.result as R), replayed: true };
  }

  const { value, record } = await ops.run();
  await tx.insert(idempotencyKeys).values({
    tenantId: scope.tenantId,
    key: scope.key,
    operation: scope.operation,
    requestHash: hash,
    result: record,
  });
  return { value, replayed: false };
}

export function validateRequestKey(key: string): void {
  try {
    validateIdempotencyKey(key);
  } catch (error) {
    throw new ContestError('invalid_input', error instanceof Error ? error.message : 'invalid idempotencyKey', { cause: 'idempotencyKey' });
  }
  if (key.length > REQUEST_KEY_MAX) {
    throw new ContestError('invalid_input', `idempotencyKey must be at most ${REQUEST_KEY_MAX} characters`, { length: key.length });
  }
}

/** A ledger key derived from a request key, so the journal's own idempotency is keyed by the same request. */
export function ledgerKey(prefix: string, requestKey: string): string {
  return `${prefix}:${requestKey}`;
}
