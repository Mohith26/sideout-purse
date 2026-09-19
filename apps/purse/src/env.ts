import { z } from 'zod';

/**
 * Which implementation may fill each provider seam (spec 4.5). Only `dev` exists today; a
 * vendor integration adds its name here and a branch in `src/providers/index.ts`. Declared
 * here rather than in `src/providers` so this module keeps no local imports: the
 * repository-level `test/env-isolation.test.ts` compiles it on its own.
 */
export const PROVIDER_IMPLEMENTATIONS = ['dev'] as const;
export type ProviderImplementation = (typeof PROVIDER_IMPLEMENTATIONS)[number];

/**
 * The process secret every derived key comes from (`src/secrets.ts`): the embed session
 * signature, the sign-in code HMAC and the webhook signing-secret encryption. Required in
 * production; outside it this value stands in so a fresh clone runs `pnpm dev` with no
 * setup, and the boot log says so.
 */
export const DEVELOPMENT_SECRET_KEY = 'purse-development-secret-key-not-for-production-use';
export const SECRET_KEY_MIN_LENGTH = 32;

/** The embed's SMS seam (spec 4.8 sign-in): `log` writes the code to the log and echoes it to the browser; production refuses it. */
export const SMS_IMPLEMENTATIONS = ['log', 'none'] as const;
export type SmsImplementation = (typeof SMS_IMPLEMENTATIONS)[number];

/**
 * Everything Purse reads from the environment, validated once.
 *
 * This module is the only place the connection strings are named. It knows
 * `PURSE_DATABASE_URL` (the runtime role, `purse_app`) and `PURSE_MIGRATOR_DATABASE_URL`
 * (the owner role, `purse_migrator`, used only by `db:migrate`, `db:seed` and the test
 * reset) and nothing about Sideout's; decision D2 says the two apps' strings are never
 * loaded into one process, and `test/env-isolation.test.ts` at the repository root proves
 * `loadEnv` ignores Sideout's even when both are present. The provider seams, the dev
 * identity lists and the rate limit are read here too; `docs/providers.md` documents them.
 * Phase 4 adds the process secret, the embed's SMS seam and static directory, and the
 * webhook dispatcher's knobs (docs/decisions.md, phase 4).
 */

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

const commaList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((each) => each.trim())
      .filter((each) => each !== ''),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BUILD_SHA: z.string().trim().min(1).optional(),
  PURSE_DATABASE_URL: postgresUrl.optional(),
  PURSE_DATABASE_URL_TEST: postgresUrl.optional(),
  PURSE_MIGRATOR_DATABASE_URL: postgresUrl.optional(),
  PURSE_MIGRATOR_DATABASE_URL_TEST: postgresUrl.optional(),
  INTERNAL_API_TOKEN: z.string().trim().min(16, 'must be at least 16 characters').optional(),
  // Provider seams (spec 4.5). Only `dev` exists; a vendor adds its name in src/providers.
  IDENTITY_PROVIDER: z.enum(PROVIDER_IMPLEMENTATIONS).default('dev'),
  GEO_PROVIDER: z.enum(PROVIDER_IMPLEMENTATIONS).default('dev'),
  RISK_PROVIDER: z.enum(PROVIDER_IMPLEMENTATIONS).default('dev'),
  // Production refuses to start on a dev provider unless this is set on purpose.
  ALLOW_DEV_PROVIDERS: z.enum(['true', 'false']).default('false'),
  // The dev identity provider's seeded lists: comma-separated external ids.
  DEV_IDENTITY_ALLOW: commaList,
  DEV_IDENTITY_DENY: commaList,
  DEV_IDENTITY_PENDING: commaList,
  // Public sandbox minting: opt in explicitly on a production demo.
  SANDBOX_SELF_SERVE: z.enum(['true', 'false']).optional(),
  // Per-key token bucket for /v1 (spec 4.7 `rate_limited`).
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(100),
  RATE_LIMIT_PER_SECOND: z.coerce.number().positive().max(100_000).default(20),
  // How many proxies in front of Purse append to X-Forwarded-For; the client address the
  // failed-authentication limit counts is taken that many entries from the header's right.
  // 0 (the default) trusts no header and uses the socket's address; the hosted deploy sets 1.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // The process secret (see DEVELOPMENT_SECRET_KEY). Production refuses to start without it.
  PURSE_SECRET_KEY: z.string().min(SECRET_KEY_MIN_LENGTH, `must be at least ${SECRET_KEY_MIN_LENGTH} characters`).optional(),
  // The embed's sign-in SMS seam. Defaults to `log` outside production and `none` in it.
  EMBED_SMS_PROVIDER: z.enum(SMS_IMPLEMENTATIONS).optional(),
  // Where the built embed app (`apps/purse-embed/out`) is served from under /embed; the
  // default is the sibling app's export when it exists.
  PURSE_EMBED_DIR: z.string().trim().min(1).optional(),
  // The in-process webhook dispatcher (spec 4.9): off for a process that should only serve.
  WEBHOOK_DISPATCHER: z.enum(['on', 'off']).default('on'),
  WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  // Webhook destination validation (docs/webhooks-security.md). Purse refuses to deliver
  // to anything but a public unicast address; these two are the deployment's own policy.
  // `WEBHOOK_ALLOWED_HOSTS` exempts named hosts from that check and is empty by default,
  // so a production deployment refuses every private destination until an operator opts
  // one in on purpose; local development and CI use it for their loopback receivers.
  // `WEBHOOK_ALLOWED_PORTS` is empty by default, which allows every port.
  WEBHOOK_ALLOWED_HOSTS: commaList,
  WEBHOOK_ALLOWED_PORTS: commaList,
});

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  buildSha: string | undefined;
  /** Runtime role, resolved for the current NODE_ENV: the `_TEST` URL under test, the real one otherwise. */
  databaseUrl: string;
  /**
   * Owner role, resolved the same way. Optional because the API process does not need it
   * and in production should not have it; `requireMigratorUrl` is for the scripts that do.
   */
  migratorDatabaseUrl: string | undefined;
  /** Bearer token for `GET /internal/reconcile`. Unset means the route is closed outside tests. */
  internalApiToken: string | undefined;
  providers: {
    identity: ProviderImplementation;
    geo: ProviderImplementation;
    risk: ProviderImplementation;
    allowDevProviders: boolean;
    devIdentity: { allow: string[]; deny: string[]; pending: string[] };
  };
  rateLimit: { burst: number; perSecond: number };
  /** Proxies whose `X-Forwarded-For` entry is trusted for the client address; 0 means the socket's address. */
  trustedProxyHops: number;
  sandboxSelfServe: boolean;
  /** `PURSE_SECRET_KEY`, or the development stand-in outside production (`secretKeyIsDefault`). */
  secretKey: string;
  secretKeyIsDefault: boolean;
  embed: {
    smsProvider: SmsImplementation;
    /** `PURSE_EMBED_DIR`, when set; otherwise the API looks for the sibling app's export. */
    staticDir: string | undefined;
  };
  webhooks: {
    dispatcher: boolean;
    pollIntervalMs: number;
    deliveryTimeoutMs: number;
    /** Hosts exempt from destination classification, lowercased. Empty unless a deployment opts in. */
    allowedHosts: string[];
    /** Ports deliveries may use; empty means every port. */
    allowedPorts: number[];
  };
};

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

/**
 * Parse an environment. Exposed as a function (rather than a module-level constant) so
 * tests can exercise it with synthetic input and so importing a module never throws.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const raw = parsed.data;
  const test = raw.NODE_ENV === 'test';

  const databaseUrl = test ? raw.PURSE_DATABASE_URL_TEST : raw.PURSE_DATABASE_URL;
  if (databaseUrl === undefined) {
    const wanted = test ? 'PURSE_DATABASE_URL_TEST' : 'PURSE_DATABASE_URL';
    throw new EnvError(`Invalid environment: ${wanted} is required when NODE_ENV=${raw.NODE_ENV}`);
  }
  const production = raw.NODE_ENV === 'production';
  if (production && raw.PURSE_SECRET_KEY === undefined) {
    throw new EnvError('Invalid environment: PURSE_SECRET_KEY is required when NODE_ENV=production');
  }
  const allowedPorts = raw.WEBHOOK_ALLOWED_PORTS.map((port) => Number.parseInt(port, 10));
  if (allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new EnvError('Invalid environment: WEBHOOK_ALLOWED_PORTS must be a comma-separated list of port numbers');
  }
  const smsProvider = raw.EMBED_SMS_PROVIDER ?? (production ? 'none' : 'log');
  if (production && smsProvider === 'log') {
    throw new EnvError('Invalid environment: EMBED_SMS_PROVIDER=log is refused when NODE_ENV=production; sign-in codes must not reach a production log');
  }

  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    buildSha: raw.BUILD_SHA,
    databaseUrl,
    migratorDatabaseUrl: test ? raw.PURSE_MIGRATOR_DATABASE_URL_TEST : raw.PURSE_MIGRATOR_DATABASE_URL,
    internalApiToken: raw.INTERNAL_API_TOKEN,
    providers: {
      identity: raw.IDENTITY_PROVIDER,
      geo: raw.GEO_PROVIDER,
      risk: raw.RISK_PROVIDER,
      allowDevProviders: raw.ALLOW_DEV_PROVIDERS === 'true',
      devIdentity: { allow: raw.DEV_IDENTITY_ALLOW, deny: raw.DEV_IDENTITY_DENY, pending: raw.DEV_IDENTITY_PENDING },
    },
    rateLimit: { burst: raw.RATE_LIMIT_BURST, perSecond: raw.RATE_LIMIT_PER_SECOND },
    trustedProxyHops: raw.TRUSTED_PROXY_HOPS,
    sandboxSelfServe: raw.SANDBOX_SELF_SERVE === undefined ? !production : raw.SANDBOX_SELF_SERVE === 'true',
    secretKey: raw.PURSE_SECRET_KEY ?? DEVELOPMENT_SECRET_KEY,
    secretKeyIsDefault: raw.PURSE_SECRET_KEY === undefined,
    embed: { smsProvider, staticDir: raw.PURSE_EMBED_DIR },
    webhooks: {
      dispatcher: raw.WEBHOOK_DISPATCHER === 'on',
      pollIntervalMs: raw.WEBHOOK_POLL_INTERVAL_MS,
      deliveryTimeoutMs: raw.WEBHOOK_DELIVERY_TIMEOUT_MS,
      allowedHosts: raw.WEBHOOK_ALLOWED_HOSTS.map((host) => host.toLowerCase().replace(/^\[|\]$/g, '')),
      allowedPorts,
    },
  };
}

/** The owner-role URL, for the scripts that migrate, seed or reset. Throws with the variable's name when unset. */
export function requireMigratorUrl(config: Env): string {
  if (config.migratorDatabaseUrl === undefined) {
    const wanted = config.nodeEnv === 'test' ? 'PURSE_MIGRATOR_DATABASE_URL_TEST' : 'PURSE_MIGRATOR_DATABASE_URL';
    throw new EnvError(`Invalid environment: ${wanted} is required when NODE_ENV=${config.nodeEnv}`);
  }
  return config.migratorDatabaseUrl;
}

let cached: Env | undefined;

/** The process environment, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
