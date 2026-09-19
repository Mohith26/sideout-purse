import { z } from 'zod';

/**
 * Everything the ping-pong ladder reads from the environment, validated once.
 *
 * This module is the only place the app's connection string is named: `PINGPONG_DATABASE_URL`
 * (and its `_TEST` twin), nothing of Purse's or Sideout's (system spec section 2, rule 1;
 * `test/env-isolation.test.ts` at the repository root proves `loadEnv` ignores the other
 * apps' strings). Purse is reached over HTTP with a secret key, never through its database:
 * `PURSE_API_URL` and `PINGPONG_PURSE_SECRET_KEY` are the server's (the key reaches no
 * browser; `scripts/check-bundle.ts` greps the built client bundle for `sk_`), and the
 * three `NEXT_PUBLIC_PURSE_*` variables are what the SDK needs in the browser: the
 * publishable key, the Purse origin the iframe is served from, and the tenant id.
 *
 * `OFFICE_CODE` is the shared word everyone in the office signs in with (this is a
 * throwaway product: the code is the whole of its authentication, docs/second-tenant.md).
 * Production requires a real one, a session secret and every Purse variable; outside
 * production a missing secret key means the Purse routes answer 503 `purse_unavailable`
 * and the office code defaults to `table-tennis`. An exported but empty variable counts
 * as unset.
 */

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

/** Only ever used outside production, so a fresh clone runs `pnpm dev` without setup. */
export const DEVELOPMENT_SESSION_SECRET = 'pingpong-development-session-secret-not-for-production';
export const DEVELOPMENT_OFFICE_CODE = 'table-tennis';

export const SESSION_SECRET_MIN_LENGTH = 32;
export const OFFICE_CODE_MIN_LENGTH = 6;

/** Where `pnpm dev` runs the Purse API, and so where a local ladder finds it. */
export const DEVELOPMENT_PURSE_API_URL = 'http://localhost:4000';
/** The tenant `pnpm --filter @purse/api db:seed` creates for this app; a hosted deploy sets the real one. */
export const DEVELOPMENT_PURSE_TENANT_ID = 'tnt_01a0c2f0-5e7a-7b4e-9d1a-4f2b8c6d0e11';

const SECRET_KEY_SHAPE = /^sk_(sandbox|live)_[A-Za-z0-9]{32}$/;
const PUBLISHABLE_KEY_SHAPE = /^pk_(sandbox|live)_[A-Za-z0-9]{32}$/;
const TENANT_ID_SHAPE = /^tnt_[0-9a-f-]{36}$/;
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), 'must be an http(s) URL');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BUILD_SHA: z.string().trim().min(1).optional(),
  PINGPONG_DATABASE_URL: postgresUrl.optional(),
  PINGPONG_DATABASE_URL_TEST: postgresUrl.optional(),
  SESSION_SECRET: z.string().min(SESSION_SECRET_MIN_LENGTH).optional(),
  OFFICE_CODE: z.string().trim().min(OFFICE_CODE_MIN_LENGTH).optional(),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  PURSE_API_URL: httpUrl.optional(),
  PINGPONG_PURSE_SECRET_KEY: z.string().regex(SECRET_KEY_SHAPE, 'must be a Purse secret key (sk_sandbox_... or sk_live_...)').optional(),
  NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: z.string().regex(PUBLISHABLE_KEY_SHAPE, 'must be a Purse publishable key (pk_sandbox_... or pk_live_...)').optional(),
  NEXT_PUBLIC_PURSE_ORIGIN: httpUrl.optional(),
  NEXT_PUBLIC_PURSE_TENANT_ID: z.string().regex(TENANT_ID_SHAPE, 'must be a Purse tenant id (tnt_...)').optional(),
});

/** The Purse connection. `secretKey` undefined (outside production only) means the integration is off. */
export type PurseEnv = {
  /** The API the server calls, origin only. */
  apiUrl: string;
  secretKey: string | undefined;
  /** What the browser needs for `Purse.init`; `publishableKey` undefined means no flow can mount. */
  publishableKey: string | undefined;
  /** The origin the iframe is served from, as the browser reaches it. */
  browserOrigin: string;
  tenantId: string;
};

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** `BUILD_SHA` if the deploy set it; `build-info.ts` falls back to git, then "unknown". */
  buildSha: string | undefined;
  /** Resolved for the current NODE_ENV: the `_TEST` URL under test, the real one otherwise. */
  databaseUrl: string;
  /** Signs session cookies. Required in production. */
  sessionSecret: string;
  /** The shared office code a player signs in with. Required in production. */
  officeCode: string;
  /** How many proxies in front of this process append to `X-Forwarded-For`. 0 means none. */
  trustedProxyHops: number;
  purse: PurseEnv;
};

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // An empty value is an unset one: a host that exports `VAR=` has not configured it.
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(source).filter(([, value]) => value !== '')));
  if (!parsed.success) {
    throw new EnvError(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const raw = parsed.data;
  const production = raw.NODE_ENV === 'production';

  const databaseUrl = raw.NODE_ENV === 'test' ? raw.PINGPONG_DATABASE_URL_TEST : raw.PINGPONG_DATABASE_URL;
  if (databaseUrl === undefined) {
    const wanted = raw.NODE_ENV === 'test' ? 'PINGPONG_DATABASE_URL_TEST' : 'PINGPONG_DATABASE_URL';
    throw new EnvError(`Invalid environment: ${wanted} is required when NODE_ENV=${raw.NODE_ENV}`);
  }

  if (production && raw.SESSION_SECRET === undefined) {
    throw new EnvError(`Invalid environment: SESSION_SECRET (at least ${SESSION_SECRET_MIN_LENGTH} characters) is required in production`);
  }
  if (production && raw.OFFICE_CODE === undefined) {
    throw new EnvError(`Invalid environment: OFFICE_CODE (at least ${OFFICE_CODE_MIN_LENGTH} characters) is required in production`);
  }

  if (production) {
    const missing = (['PURSE_API_URL', 'PINGPONG_PURSE_SECRET_KEY', 'NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_PURSE_TENANT_ID'] as const).filter((name) => raw[name] === undefined);
    if (missing.length > 0) throw new EnvError(`Invalid environment: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required in production`);
  }
  const apiUrl = new URL(raw.PURSE_API_URL ?? DEVELOPMENT_PURSE_API_URL).origin;

  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    buildSha: raw.BUILD_SHA,
    databaseUrl,
    sessionSecret: raw.SESSION_SECRET ?? DEVELOPMENT_SESSION_SECRET,
    officeCode: raw.OFFICE_CODE ?? DEVELOPMENT_OFFICE_CODE,
    trustedProxyHops: raw.TRUSTED_PROXY_HOPS,
    purse: {
      apiUrl,
      secretKey: raw.PINGPONG_PURSE_SECRET_KEY,
      publishableKey: raw.NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY,
      browserOrigin: new URL(raw.NEXT_PUBLIC_PURSE_ORIGIN ?? apiUrl).origin,
      tenantId: raw.NEXT_PUBLIC_PURSE_TENANT_ID ?? DEVELOPMENT_PURSE_TENANT_ID,
    },
  };
}

let cached: Env | undefined;

/** The process environment, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
