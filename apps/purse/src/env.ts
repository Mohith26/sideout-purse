import { z } from 'zod';

/**
 * Everything Purse reads from the environment, validated once.
 *
 * This module is the only place the connection string is named. It knows
 * `PURSE_DATABASE_URL` and nothing about Sideout's; decision D2 says the two strings are
 * never loaded into one process, and `test/env-isolation.test.ts` at the repository root
 * proves `loadEnv` ignores Sideout's even when both are present.
 */

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BUILD_SHA: z.string().trim().min(1).optional(),
  PURSE_DATABASE_URL: postgresUrl.optional(),
  PURSE_DATABASE_URL_TEST: postgresUrl.optional(),
});

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  buildSha: string | undefined;
  /** Resolved for the current NODE_ENV: the `_TEST` URL under test, the real one otherwise. */
  databaseUrl: string;
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

  const databaseUrl = raw.NODE_ENV === 'test' ? raw.PURSE_DATABASE_URL_TEST : raw.PURSE_DATABASE_URL;
  if (databaseUrl === undefined) {
    const wanted = raw.NODE_ENV === 'test' ? 'PURSE_DATABASE_URL_TEST' : 'PURSE_DATABASE_URL';
    throw new EnvError(`Invalid environment: ${wanted} is required when NODE_ENV=${raw.NODE_ENV}`);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    buildSha: raw.BUILD_SHA,
    databaseUrl,
  };
}

let cached: Env | undefined;

/** The process environment, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
