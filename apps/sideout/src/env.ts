import { z } from 'zod';

/**
 * Everything Sideout reads from the environment, validated once.
 *
 * This module is the only place Sideout's connection string is named. It knows
 * `SIDEOUT_DATABASE_URL` and nothing about Purse's (decision D2); the env-isolation test
 * at the repository root proves `loadEnv` ignores Purse's even when both are present.
 * Purse is reached over HTTPS with a secret key (phase 7), never through its database.
 *
 * Production is stricter than development on purpose: a real session secret is required,
 * the `log` SMS sender is refused, and with no Stripe key configured registration refuses
 * rather than faking a donation (see `server/donations/provider.ts`).
 */

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

/** Only ever used outside production, so a fresh clone runs `pnpm dev` without setup. */
export const DEVELOPMENT_SESSION_SECRET = 'sideout-development-session-secret-not-for-production';

export const SESSION_SECRET_MIN_LENGTH = 32;

/** How long a registration with an unpaid donation holds its place (`server/field.ts`). */
export const DEFAULT_RESERVATION_TTL_MINUTES = 30;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BUILD_SHA: z.string().trim().min(1).optional(),
  SIDEOUT_DATABASE_URL: postgresUrl.optional(),
  SIDEOUT_DATABASE_URL_TEST: postgresUrl.optional(),
  SESSION_SECRET: z.string().min(SESSION_SECRET_MIN_LENGTH).optional(),
  SMS_PROVIDER: z.enum(['log']).optional(),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  STRIPE_SECRET_KEY: z.string().trim().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(DEFAULT_RESERVATION_TTL_MINUTES),
});

export type SmsProviderName = 'log' | 'none';
export type DonationProviderSelection = 'stripe' | 'dev' | 'none';

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** `BUILD_SHA` if the deploy set it; `build-info.ts` falls back to git, then "unknown". */
  buildSha: string | undefined;
  /** Resolved for the current NODE_ENV: the `_TEST` URL under test, the real one otherwise. */
  databaseUrl: string;
  /** Signs session cookies and one-time codes. Required in production. */
  sessionSecret: string;
  /** `log` writes codes to the log (never in production); `none` means request-code refuses. */
  smsProvider: SmsProviderName;
  /** How many proxies in front of this process append to `X-Forwarded-For`. 0 means none. */
  trustedProxyHops: number;
  /** Which donation provider is configured; `none` means registration refuses (production only). */
  donationProvider: DonationProviderSelection;
  stripe: { secretKey: string; webhookSecret: string } | undefined;
  /** `RESERVATION_TTL_MINUTES` in milliseconds: how long an unpaid registration holds a place. */
  reservationTtlMs: number;
};

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const raw = parsed.data;
  const production = raw.NODE_ENV === 'production';

  const databaseUrl = raw.NODE_ENV === 'test' ? raw.SIDEOUT_DATABASE_URL_TEST : raw.SIDEOUT_DATABASE_URL;
  if (databaseUrl === undefined) {
    const wanted = raw.NODE_ENV === 'test' ? 'SIDEOUT_DATABASE_URL_TEST' : 'SIDEOUT_DATABASE_URL';
    throw new EnvError(`Invalid environment: ${wanted} is required when NODE_ENV=${raw.NODE_ENV}`);
  }

  if (production && raw.SESSION_SECRET === undefined) {
    throw new EnvError(`Invalid environment: SESSION_SECRET (at least ${SESSION_SECRET_MIN_LENGTH} characters) is required in production`);
  }
  const sessionSecret = raw.SESSION_SECRET ?? DEVELOPMENT_SESSION_SECRET;

  if (production && raw.SMS_PROVIDER === 'log') {
    throw new EnvError('Invalid environment: SMS_PROVIDER=log is not permitted in production; codes would be written to the log');
  }
  const smsProvider: SmsProviderName = production ? 'none' : (raw.SMS_PROVIDER ?? 'log');

  if ((raw.STRIPE_SECRET_KEY === undefined) !== (raw.STRIPE_WEBHOOK_SECRET === undefined)) {
    throw new EnvError('Invalid environment: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set together');
  }
  const stripe =
    raw.STRIPE_SECRET_KEY !== undefined && raw.STRIPE_WEBHOOK_SECRET !== undefined
      ? { secretKey: raw.STRIPE_SECRET_KEY, webhookSecret: raw.STRIPE_WEBHOOK_SECRET }
      : undefined;
  const donationProvider: DonationProviderSelection = stripe !== undefined ? 'stripe' : production ? 'none' : 'dev';

  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    buildSha: raw.BUILD_SHA,
    databaseUrl,
    sessionSecret,
    smsProvider,
    trustedProxyHops: raw.TRUSTED_PROXY_HOPS,
    donationProvider,
    stripe,
    reservationTtlMs: raw.RESERVATION_TTL_MINUTES * 60_000,
  };
}

let cached: Env | undefined;

/** The process environment, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
