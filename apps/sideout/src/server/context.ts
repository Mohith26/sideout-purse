import { database, type Db } from '../db/client';
import { env, type Env } from '../env';
import { logger } from '../lib/logger';
import { createRateLimiter } from './auth/rate-limit';
import { createAuthService, type AuthService } from './auth/service';
import { logSmsSender, unavailableSmsSender, type SmsSender } from './auth/sms';
import { devDonationProvider } from './donations/dev';
import type { DonationProvider } from './donations/provider';
import { stripeDonationProvider } from './donations/stripe';
import { purseContestEntryNotWired, type PurseContestEntry } from './registration';

/**
 * The process-wide wiring the route handlers use: the database, the auth service with
 * its rate limiters, the SMS sender and the donation provider the environment selects.
 * Built once and cached on `globalThis` so `next dev` hot reloads keep one set of rate
 * limit counters; tests call `resetAppContext()` between scenarios.
 */
export type AppContext = {
  env: Env;
  db: Db;
  auth: AuthService;
  sms: SmsSender;
  donationProvider: DonationProvider | null;
  purseEntry: PurseContestEntry;
};

/** Request-code limits: per address, per phone, and for the whole process. */
export const AUTH_RATE_LIMITS = {
  perAddress: { limit: 5, windowMs: 10 * 60_000, maxKeys: 10_000 },
  perPhone: { limit: 3, windowMs: 10 * 60_000, maxKeys: 10_000 },
  global: { limit: 120, windowMs: 60_000, maxKeys: 1 },
} as const;

export type AppContextOverrides = Partial<Pick<AppContext, 'sms' | 'donationProvider' | 'purseEntry' | 'env'>>;

export function buildAppContext(config: Env, db: Db, overrides: AppContextOverrides = {}): AppContext {
  const log = logger(config.logLevel);
  const sms = overrides.sms ?? (config.smsProvider === 'log' ? logSmsSender(log) : unavailableSmsSender);
  const donationProvider =
    'donationProvider' in overrides
      ? (overrides.donationProvider ?? null)
      : config.donationProvider === 'stripe' && config.stripe !== undefined
        ? stripeDonationProvider({ secretKey: config.stripe.secretKey })
        : config.donationProvider === 'dev'
          ? devDonationProvider
          : null;
  const auth = createAuthService({
    db,
    sms,
    sessionSecret: config.sessionSecret,
    echoCodes: config.nodeEnv !== 'production',
    limiters: {
      perAddress: createRateLimiter(AUTH_RATE_LIMITS.perAddress),
      perPhone: createRateLimiter(AUTH_RATE_LIMITS.perPhone),
      global: createRateLimiter(AUTH_RATE_LIMITS.global),
    },
  });
  return {
    env: overrides.env ?? config,
    db,
    auth,
    sms,
    donationProvider,
    purseEntry: overrides.purseEntry ?? purseContestEntryNotWired,
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
