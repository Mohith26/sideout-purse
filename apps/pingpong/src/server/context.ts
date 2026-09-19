import type { Logger } from '@repo/logger';

import { database, type Db } from '../db/client';
import { env, type Env } from '../env';
import { logger } from '../lib/logger';
import { databaseCallRecorder, PurseClient } from '../purse';

/**
 * The process-wide wiring the route handlers use: the environment, the database and the
 * Purse client. Built once and cached on `globalThis` so `next dev` hot reloads keep one
 * pool; tests call `resetAppContext()` between scenarios, passing an in-memory Purse.
 */
export type AppContext = {
  env: Env;
  db: Db;
  /** The Purse client, or null when `PINGPONG_PURSE_SECRET_KEY` is unset (outside production only); routes answer 503 `purse_unavailable`. */
  purse: PurseClient | null;
  log: Logger;
};

export type AppContextOverrides = Partial<Pick<AppContext, 'env' | 'purse'>>;

export function buildAppContext(base: Env, db: Db, overrides: AppContextOverrides = {}): AppContext {
  const config = overrides.env ?? base;
  const log = logger(config.logLevel);
  const purse =
    'purse' in overrides
      ? (overrides.purse ?? null)
      : config.purse.secretKey === undefined
        ? null
        : new PurseClient({ baseUrl: config.purse.apiUrl, secretKey: config.purse.secretKey, recorder: databaseCallRecorder(db) });
  return { env: config, db, purse, log };
}

const globalContext = globalThis as typeof globalThis & { __pingpongContext?: AppContext };

export function appContext(): AppContext {
  globalContext.__pingpongContext ??= buildAppContext(env(), database().db);
  return globalContext.__pingpongContext;
}

/** Rebuild the context (tests): with overrides, or from the environment again. */
export function resetAppContext(overrides: AppContextOverrides = {}): AppContext {
  globalContext.__pingpongContext = buildAppContext(env(), database().db, overrides);
  return globalContext.__pingpongContext;
}
