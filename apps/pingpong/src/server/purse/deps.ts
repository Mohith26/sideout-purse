import type { Logger } from '@repo/logger';

import type { Db } from '../../db/client';
import type { PurseEnv } from '../../env';
import { isPurseFailure, PurseApiError, type PurseClient } from '../../purse';
import { failure } from '../http/errors';

/**
 * What every Purse-facing service takes: the database, the configured client, the
 * process logger and the Purse part of the environment. `requirePurse` turns "no secret
 * key" into the one API answer for it, a 503 `purse_unavailable`.
 */
export type PurseDeps = { db: Db; purse: PurseClient; log: Logger; env: PurseEnv };

export function requirePurse(context: { db: Db; purse: PurseClient | null; log: Logger; env: { purse: PurseEnv } }): PurseDeps {
  if (context.purse === null) throw failure.internal('purse_unavailable', 'Purse is not configured on this server.').withStatus(503);
  return { db: context.db, purse: context.purse, log: context.log, env: context.env.purse };
}

/** Purse's rule for a key: no whitespace, at most 200 characters. */
export function idempotencyKey(...parts: string[]): string {
  const key = parts.join(':').replace(/\s+/g, '_');
  return key.length <= 200 ? key : key.slice(0, 200);
}

/** Purse's `not_eligible` and friends as they reach a caller through a ladder route, unchanged in type and code. */
export function purseFailureToApi(error: unknown): never {
  if (error instanceof PurseApiError) {
    if (error.type === 'not_eligible' || error.type === 'insufficient_funds') {
      throw failure.invalidState(error.code, error.message, { purse: error.toJSON() }).withStatus(error.status);
    }
    throw failure.internal('purse_refused', `Purse refused the request: ${error.message}`, { purse: error.toJSON() }).withStatus(502);
  }
  if (isPurseFailure(error)) throw failure.internal('purse_unreachable', error.message).withStatus(502);
  throw error;
}
