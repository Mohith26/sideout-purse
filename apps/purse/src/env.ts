import { z } from 'zod';

import { PROVIDER_IMPLEMENTATIONS, type ProviderImplementation } from './providers';

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
  // Per-key token bucket for /v1 (spec 4.7 `rate_limited`).
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(100),
  RATE_LIMIT_PER_SECOND: z.coerce.number().positive().max(100_000).default(20),
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
