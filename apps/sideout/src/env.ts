import { z } from 'zod';

/**
 * Everything Sideout reads from the environment, validated once.
 *
 * This module is the only place Sideout's connection string is named. It knows
 * `SIDEOUT_DATABASE_URL` and nothing about Purse's (decision D2); the env-isolation test
 * at the repository root greps both apps to keep it that way. Purse is reached over HTTPS
 * with a secret key (phase 4), never through its database.
 */

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BUILD_SHA: z.string().trim().min(1).optional(),
  SIDEOUT_DATABASE_URL: postgresUrl.optional(),
  SIDEOUT_DATABASE_URL_TEST: postgresUrl.optional(),
});

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** `BUILD_SHA` if the deploy set it; `build-info.ts` falls back to git, then "unknown". */
  buildSha: string | undefined;
  /** Resolved for the current NODE_ENV: the `_TEST` URL under test, the real one otherwise. */
  databaseUrl: string;
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

  const databaseUrl = raw.NODE_ENV === 'test' ? raw.SIDEOUT_DATABASE_URL_TEST : raw.SIDEOUT_DATABASE_URL;
  if (databaseUrl === undefined) {
    const wanted = raw.NODE_ENV === 'test' ? 'SIDEOUT_DATABASE_URL_TEST' : 'SIDEOUT_DATABASE_URL';
    throw new EnvError(`Invalid environment: ${wanted} is required when NODE_ENV=${raw.NODE_ENV}`);
  }

  return {
    nodeEnv: raw.NODE_ENV,
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
