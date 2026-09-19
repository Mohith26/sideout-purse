import type { Logger } from '@repo/logger';

import { database, type Db } from '../db/client';
import { env, type Env } from '../env';
import { logger } from '../lib/logger';
import { databaseCallRecorder, PurseClient } from '../purse';
import { DEMO_SIGN_IN_LIMITS, type DemoLimiters } from './auth/demo';
import { createRateLimiter } from './auth/rate-limit';
import { createAuthService, type AuthService } from './auth/service';
import { logSmsSender, unavailableSmsSender, type SmsSender } from './auth/sms';
import { devDonationProvider } from './donations/dev';
import type { DonationProvider } from './donations/provider';
import { stripeDonationProvider } from './donations/stripe';
import { purseContestEntryNotWired, purseContestEntryWired, type PurseContestEntry } from './registration';

/**
 * The process-wide wiring the route handlers use: the database, the auth service with
 * its rate limiters, the demo sign-in's limiters, the SMS sender and the donation
 * provider the environment selects.
 * Built once and cached on `globalThis` so `next dev` hot reloads keep one set of rate
 * limit counters; tests call `resetAppContext()` between scenarios.
 */
export type AppContext = {
  env: Env;
  db: Db;
  auth: AuthService;
  /** The demo sign-in's buckets (`auth/demo.ts`); built whatever the switch says, so a toggle needs no rewiring. */
  demoLimiters: DemoLimiters;
  sms: SmsSender;
  donationProvider: DonationProvider | null;
  purseEntry: PurseContestEntry;
  /** The Purse client, or null when `SIDEOUT_PURSE_SECRET_KEY` is unset (outside production only); routes answer 503 `purse_unavailable`. */
  purse: PurseClient | null;
  log: Logger;
};

/** Five per address per ten minutes, for code requests and, on its own counter, for verify attempts. */
const PER_ADDRESS = { limit: 5, windowMs: 10 * 60_000, maxKeys: 10_000 } as const;

/**
 * Sign-in limits over a ten-minute window: code requests per address, per phone and for
 * the whole process (the SMS budget, from `AUTH_CODE_GLOBAL_CAP`), and verify attempts per
 * address. These are per process and bound nothing but request rates: which codes are
 * live is decided by expiry alone (`auth/service.ts`). The verify counter is separate from
 * the request counter on purpose, so one sign-in (a request and a verify) costs one slot
 * of each rather than two of one (docs/decisions.md).
 */
export const AUTH_RATE_LIMITS = {
  perAddress: PER_ADDRESS,
  perPhone: { limit: 3, windowMs: 10 * 60_000, maxKeys: 10_000 },
  global: { windowMs: 10 * 60_000, maxKeys: 1 },
  verifyPerAddress: PER_ADDRESS,
} as const;

export type AppContextOverrides = Partial<Pick<AppContext, 'sms' | 'donationProvider' | 'purseEntry' | 'env' | 'purse'>>;

export function buildAppContext(base: Env, db: Db, overrides: AppContextOverrides = {}): AppContext {
  const config = overrides.env ?? base;
  const log = logger(config.logLevel);
  const sms = overrides.sms ?? (config.smsProvider === 'log' ? logSmsSender(log) : unavailableSmsSender);
  const donationProvider =
    'donationProvider' in overrides
      ? (overrides.donationProvider ?? null)
      : config.donationProvider === 'stripe' && config.stripe !== undefined
        ? stripeDonationProvider({ secretKey: config.stripe.secretKey })
        : config.donationProvider === 'dev'
          ? devDonationProvider({ db, reservationTtlMs: config.reservationTtlMs })
          : null;
  const auth = createAuthService({
    db,
    sms,
    sessionSecret: config.sessionSecret,
    echoCodes: config.nodeEnv !== 'production',
    limiters: {
      perAddress: createRateLimiter(AUTH_RATE_LIMITS.perAddress),
      perPhone: createRateLimiter(AUTH_RATE_LIMITS.perPhone),
      global: createRateLimiter({ ...AUTH_RATE_LIMITS.global, limit: config.authCodeGlobalCap }),
      verifyPerAddress: createRateLimiter(AUTH_RATE_LIMITS.verifyPerAddress),
    },
  });
  const demoLimiters: DemoLimiters = { perAddress: createRateLimiter(DEMO_SIGN_IN_LIMITS.perAddress), global: createRateLimiter(DEMO_SIGN_IN_LIMITS.global) };
  const purse =
    'purse' in overrides
      ? (overrides.purse ?? null)
      : config.purse.secretKey === undefined
        ? null
        : new PurseClient({ baseUrl: config.purse.apiUrl, secretKey: config.purse.secretKey, recorder: databaseCallRecorder(db) });
  if (purse === null && config.nodeEnv !== 'test') log.warn('SIDEOUT_PURSE_SECRET_KEY is not set; the Purse integration answers purse_unavailable until it is');
  const purseEntry = overrides.purseEntry ?? (purse === null ? purseContestEntryNotWired : purseContestEntryWired({ db, purse, log, env: config.purse }));
  return {
    env: config,
    db,
    auth,
    demoLimiters,
    sms,
    donationProvider,
    purseEntry,
    purse,
    log,
  };
}

const globalContext = globalThis as typeof globalThis & { __sideoutAppContext?: AppContext };

export function appContext(): AppContext {
  globalContext.__sideoutAppContext ??= buildAppContext(env(), database().db);
  return globalContext.__sideoutAppContext;
}

/**
 * Drop the cached context so the next request rebuilds it with fresh rate limiters, or
 * rebuild it now with test doubles in place of the environment's choices.
 */
export function resetAppContext(overrides?: AppContextOverrides): void {
  if (overrides === undefined) {
    delete globalContext.__sideoutAppContext;
    return;
  }
  globalContext.__sideoutAppContext = buildAppContext(env(), database().db, overrides);
}
