import type { Logger } from '@repo/logger';

import type { Db } from '../../db/client';
import type { PurseEnv } from '../../env';
import { type PurseClient } from '../../purse';
import { failure } from '../http/errors';

/**
 * What every Purse-facing service takes: the database, the configured client, the
 * process logger and the Purse part of the environment. `requirePurse` turns "no secret
 * key" into the one API answer for it, a 503 `purse_unavailable`, so a route never
 * reaches for a client that is not there.
 */
export type PurseDeps = { db: Db; purse: PurseClient; log: Logger; env: PurseEnv };

export function requirePurse(context: { db: Db; purse: PurseClient | null; log: Logger; env: { purse: PurseEnv } }): PurseDeps {
  if (context.purse === null) throw failure.internal('purse_unavailable', 'Purse is not configured on this server.').withStatus(503);
  return { db: context.db, purse: context.purse, log: context.log, env: context.env.purse };
}

/** Purse's rule for a key: no whitespace, at most 200 characters. Ours are ASCII and short, but a slug or id could not be trusted to be. */
export function idempotencyKey(...parts: string[]): string {
  const key = parts.join(':').replace(/\s+/g, '_');
  return key.length <= 200 ? key : key.slice(0, 200);
}
