import { z } from 'zod';

import { switchFrom } from './lib/switch';

/**
 * Everything Sideout reads from the environment, validated once.
 *
 * This module is the only place Sideout's connection string is named. It knows
 * `SIDEOUT_DATABASE_URL` and nothing about Purse's (decision D2); the env-isolation test
 * at the repository root proves `loadEnv` ignores Purse's even when both are present.
 * Purse is reached over HTTPS with a secret key, never through its database: `PURSE_API_URL`
 * and `SIDEOUT_PURSE_SECRET_KEY` are the server's (the key reaches no browser; `scripts/check-bundle.ts`
 * greps the built client bundle for `sk_`; the name carries the `SIDEOUT_` prefix because
 * `PURSE_SECRET_KEY` is Purse's own process secret and the two apps share an environment in
 * CI and on a developer's machine), `PURSE_WEBHOOK_SECRET` signs what Purse sends
 * back, and the three `NEXT_PUBLIC_PURSE_*` variables are what the SDK needs in the browser:
 * the publishable key, the Purse origin the iframe is served from, and the tenant id.
 *
 * Production is stricter than development on purpose: a real session secret is required,
 * the `log` SMS sender is refused, with no Stripe key configured registration refuses
 * rather than faking a donation (see `server/donations/provider.ts`), and every Purse
 * variable is required; outside production a missing secret key simply means the Purse
 * integration answers `purse_unavailable` until one is set. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
 * is what the browser mounts Stripe's Payment Element with; it is public by design and
 * optional, and the register screen says plainly when it is missing.
 *
 * `DEMO_ACCOUNTS` is the public demo's sign-in switch (`docs/demo-accounts.md`): on, `/sign-in`
 * offers the curated seeded accounts and `POST /api/auth/demo` signs a visitor in as one of
 * them. Off by default, and refused beside anything that is not demo-safe: a live Purse key,
 * a live Stripe key, or a real SMS provider. Under it, and only under it, production may run
 * the `dev` donation provider so registration completes without Stripe (a configured Stripe
 * key still wins). `next.config.ts` derives `NEXT_PUBLIC_DEMO_ACCOUNTS` from it at build time
 * and a build made for the other setting refuses to boot (`BUILT_DEMO_ACCOUNTS`, below).
 *
 * The four `LIVE_*` variables bound the live-score streams (`docs/live.md`): how many
 * `GET /api/live/*` connections one process and one address may hold open, the heartbeat
 * cadence that keeps a proxy from closing an idle stream, and how long a stream lives
 * before the server closes it and the browser reconnects. Every one has a default that is
 * safe outside production and in it.
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

/** Sign-in codes one instance will send in any ten-minute window: the SMS budget. */
export const DEFAULT_AUTH_CODE_GLOBAL_CAP = 600;

/** Where `pnpm dev` runs the Purse API, and so where a local Sideout finds it. */
export const DEVELOPMENT_PURSE_API_URL = 'http://localhost:4000';
/** The tenant `pnpm --filter @purse/api db:seed` creates; a hosted deploy sets the real one. */
export const DEVELOPMENT_PURSE_TENANT_ID = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9';

/** Open live streams one process serves before it answers 429 (`server/live/stream.ts`). */
export const DEFAULT_LIVE_MAX_STREAMS = 500;
/** Open live streams one client address may hold: a few tabs, not a fan-out. */
export const DEFAULT_LIVE_MAX_STREAMS_PER_ADDRESS = 8;
/** A comment line on every open stream at this cadence, inside the 15-25 second window proxies tolerate. */
export const DEFAULT_LIVE_HEARTBEAT_MS = 20_000;
/** A stream is closed cleanly after this long and the browser reconnects; connections never live forever. */
export const DEFAULT_LIVE_STREAM_TTL_SECONDS = 15 * 60;

const SECRET_KEY_SHAPE = /^sk_(sandbox|live)_[A-Za-z0-9]{32}$/;
const PUBLISHABLE_KEY_SHAPE = /^pk_(sandbox|live)_[A-Za-z0-9]{32}$/;
const TENANT_ID_SHAPE = /^tnt_[0-9a-f-]{36}$/;
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), 'must be an http(s) URL');
/** A Stripe test-mode secret or restricted key; anything else beside `DEMO_ACCOUNTS` is refused. */
const STRIPE_TEST_SECRET_SHAPE = /^(sk|rk)_test_/;
/** The SMS senders a demo may run beside: the log sender and none at all. A real provider, when one is added, is not on this list. */
const DEMO_SAFE_SMS_PROVIDERS: ReadonlySet<string> = new Set(['log']);

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
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]+$/, 'must be a Stripe publishable key (pk_test_... or pk_live_...)').optional(),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(DEFAULT_RESERVATION_TTL_MINUTES),
  AUTH_CODE_GLOBAL_CAP: z.coerce.number().int().min(1).max(1_000_000).default(DEFAULT_AUTH_CODE_GLOBAL_CAP),
  PURSE_API_URL: httpUrl.optional(),
  SIDEOUT_PURSE_SECRET_KEY: z.string().regex(SECRET_KEY_SHAPE, 'must be a Purse secret key (sk_sandbox_... or sk_live_...)').optional(),
  PURSE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: z.string().regex(PUBLISHABLE_KEY_SHAPE, 'must be a Purse publishable key (pk_sandbox_... or pk_live_...)').optional(),
  NEXT_PUBLIC_PURSE_ORIGIN: httpUrl.optional(),
  NEXT_PUBLIC_PURSE_TENANT_ID: z.string().regex(TENANT_ID_SHAPE, 'must be a Purse tenant id (tnt_...)').optional(),
  DEMO_ACCOUNTS: z.string().optional(),
  NEXT_PUBLIC_DEMO_ACCOUNTS: z.string().optional(),
  LIVE_MAX_STREAMS: z.coerce.number().int().min(1).max(100_000).default(DEFAULT_LIVE_MAX_STREAMS),
  LIVE_MAX_STREAMS_PER_ADDRESS: z.coerce.number().int().min(1).max(10_000).default(DEFAULT_LIVE_MAX_STREAMS_PER_ADDRESS),
  LIVE_HEARTBEAT_MS: z.coerce.number().int().min(5_000).max(25_000).default(DEFAULT_LIVE_HEARTBEAT_MS),
  LIVE_STREAM_TTL_SECONDS: z.coerce.number().int().min(30).max(24 * 3600).default(DEFAULT_LIVE_STREAM_TTL_SECONDS),
});

export type SmsProviderName = 'log' | 'none';
export type DonationProviderSelection = 'stripe' | 'dev' | 'none';

/** The Purse connection. `secretKey` undefined (outside production only) means the integration is off. */
export type PurseEnv = {
  /** The API the server calls, origin only. */
  apiUrl: string;
  secretKey: string | undefined;
  /** Verifies `Purse-Signature` on `POST /api/webhooks/purse`; unset, the receiver answers 503. */
  webhookSecret: string | undefined;
  /** What the browser needs for `Purse.init`; `publishableKey` undefined means the entry step cannot mount. */
  publishableKey: string | undefined;
  /** The origin the iframe is served from, as the browser reaches it. */
  browserOrigin: string;
  tenantId: string;
};

/** Bounds on the live-score streams (`GET /api/live/*`, `docs/live.md`). */
export type LiveEnv = {
  /** `LIVE_MAX_STREAMS`: open streams per process before the route answers 429. */
  maxStreams: number;
  /** `LIVE_MAX_STREAMS_PER_ADDRESS`: open streams one client address may hold. */
  maxStreamsPerAddress: number;
  /** `LIVE_HEARTBEAT_MS`: the comment-line cadence that keeps proxies from closing a quiet stream. */
  heartbeatMs: number;
  /** `LIVE_STREAM_TTL_SECONDS` in milliseconds: a stream is closed after this long and the browser reconnects. */
  streamTtlMs: number;
};

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
  /** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: what the Payment Element mounts with; without it the register screen says the card form is unavailable. */
  stripePublishableKey: string | undefined;
  /** `RESERVATION_TTL_MINUTES` in milliseconds: how long an unpaid registration holds a place. */
  reservationTtlMs: number;
  /** `AUTH_CODE_GLOBAL_CAP`: sign-in codes this instance sends per ten minutes across every number. */
  authCodeGlobalCap: number;
  purse: PurseEnv;
  /** `DEMO_ACCOUNTS`: the sign-in picker and `POST /api/auth/demo` exist in this process. */
  demoAccounts: boolean;
  live: LiveEnv;
};

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

/**
 * What `next build` inlined for `NEXT_PUBLIC_DEMO_ACCOUNTS`: a literal read, which Next
 * replaces at build time (`next.config.ts` derives the value from `DEMO_ACCOUNTS` then), so
 * under `next start` this is the build's setting whatever the process environment says. In
 * the bundled scripts (`dist/*.js`) and under vitest it is a plain runtime read, and unset
 * means "as the server".
 */
const BUILT_DEMO_ACCOUNTS = process.env.NEXT_PUBLIC_DEMO_ACCOUNTS;

export function loadEnv(source: Record<string, string | undefined> = process.env, built: string | undefined = BUILT_DEMO_ACCOUNTS): Env {
  // An empty value is an unset one: a host that exports `VAR=` has not configured it.
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(source).filter(([, value]) => value !== '')));
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
  const demoAccounts = switchFrom(raw.DEMO_ACCOUNTS);
  if (demoAccounts) {
    // A demo picker must never sign visitors in beside anything real: the Purse key must be
    // a sandbox one, the Stripe keys test-mode ones, and the SMS sender the log or none.
    const unsafe: string[] = [];
    if (raw.SIDEOUT_PURSE_SECRET_KEY?.startsWith('sk_live_') === true) unsafe.push('SIDEOUT_PURSE_SECRET_KEY is a live key');
    if (raw.NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY?.startsWith('pk_live_') === true) unsafe.push('NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY is a live key');
    if (raw.STRIPE_SECRET_KEY !== undefined && !STRIPE_TEST_SECRET_SHAPE.test(raw.STRIPE_SECRET_KEY)) unsafe.push('STRIPE_SECRET_KEY is not a test-mode key');
    if (raw.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.startsWith('pk_live_') === true) unsafe.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a live key');
    if (raw.SMS_PROVIDER !== undefined && !DEMO_SAFE_SMS_PROVIDERS.has(raw.SMS_PROVIDER)) unsafe.push(`SMS_PROVIDER=${raw.SMS_PROVIDER} is a real provider`);
    if (unsafe.length > 0) throw new EnvError(`Invalid environment: DEMO_ACCOUNTS=true is only permitted beside demo-safe providers (${unsafe.join('; ')})`);
  }
  // The browser bundle and the server-rendered picker must agree: a build made without the
  // switch started with it (or the reverse) would show a picker its routes refuse, or hide
  // one they accept. An unset build value (the scripts, vitest) means "as the server".
  const builtDemoAccounts = built === undefined || built === '' ? demoAccounts : switchFrom(built);
  if (builtDemoAccounts !== demoAccounts) {
    throw new EnvError(`Invalid environment: NEXT_PUBLIC_DEMO_ACCOUNTS was ${built ?? ''} at build time but DEMO_ACCOUNTS is ${demoAccounts}; the build must be made with the DEMO_ACCOUNTS it runs under`);
  }

  // Outside production the dev provider stands in for Stripe; in production only the public
  // demo may run it (docs/decisions.md, "Stretch: demo accounts"), and a configured Stripe
  // key wins wherever it is set, so adding test keys later needs no code change.
  const donationProvider: DonationProviderSelection = stripe !== undefined ? 'stripe' : production && !demoAccounts ? 'none' : 'dev';

  if (production) {
    const missing = (['PURSE_API_URL', 'SIDEOUT_PURSE_SECRET_KEY', 'PURSE_WEBHOOK_SECRET', 'NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_PURSE_TENANT_ID'] as const).filter((name) => raw[name] === undefined);
    if (missing.length > 0) throw new EnvError(`Invalid environment: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required in production`);
  }
  const apiUrl = new URL(raw.PURSE_API_URL ?? DEVELOPMENT_PURSE_API_URL).origin;
  const purse: PurseEnv = {
    apiUrl,
    secretKey: raw.SIDEOUT_PURSE_SECRET_KEY,
    webhookSecret: raw.PURSE_WEBHOOK_SECRET,
    publishableKey: raw.NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY,
    browserOrigin: new URL(raw.NEXT_PUBLIC_PURSE_ORIGIN ?? apiUrl).origin,
    tenantId: raw.NEXT_PUBLIC_PURSE_TENANT_ID ?? DEVELOPMENT_PURSE_TENANT_ID,
  };

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
    stripePublishableKey: raw.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    reservationTtlMs: raw.RESERVATION_TTL_MINUTES * 60_000,
    authCodeGlobalCap: raw.AUTH_CODE_GLOBAL_CAP,
    purse,
    demoAccounts,
    live: {
      maxStreams: raw.LIVE_MAX_STREAMS,
      maxStreamsPerAddress: raw.LIVE_MAX_STREAMS_PER_ADDRESS,
      heartbeatMs: raw.LIVE_HEARTBEAT_MS,
      streamTtlMs: raw.LIVE_STREAM_TTL_SECONDS * 1000,
    },
  };
}

let cached: Env | undefined;

/** The process environment, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
