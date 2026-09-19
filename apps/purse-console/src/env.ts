import { z } from 'zod';

/**
 * Everything the console reads from the environment, validated once. The console owns no
 * database and no secret key: it needs the Purse API's origin and nothing else. The
 * cookie is `Secure` in production (and never on plain-HTTP localhost), and the sign-in
 * form is reachable by anyone who can reach the origin, which is why the API rate limits
 * failed sign-ins by address (`TRUSTED_PROXY_HOPS` there).
 */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BUILD_SHA: z.string().trim().min(1).optional(),
  // Where the Purse API answers `/console/*`; the console calls it server-to-server only.
  PURSE_API_ORIGIN: z.string().url().default('http://localhost:4000'),
  // The Sideout origin the public `/status` page probes (`/health`, server side, short
  // timeout). Optional: unset, the page says Sideout is not configured and probes nothing.
  SIDEOUT_ORIGIN: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().url().optional()),
});

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  buildSha: string | undefined;
  apiOrigin: string;
  /** The Sideout origin `/status` probes, or `undefined` when none is configured. */
  sideoutOrigin: string | undefined;
  /** Whether the session cookie carries `Secure`: always in production. */
  secureCookies: boolean;
};

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new EnvError(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  const raw = parsed.data;
  const production = raw.NODE_ENV === 'production';
  const apiOrigin = raw.PURSE_API_ORIGIN.replace(/\/+$/, '');
  // The session token travels on this connection: in production it is TLS, or loopback (a
  // `next start` on the same machine as the API, which is what the e2e smoke runs).
  if (production && !apiOrigin.startsWith('https://') && !LOOPBACK.test(apiOrigin)) {
    throw new EnvError('Invalid environment: PURSE_API_ORIGIN must be https:// (or loopback) when NODE_ENV=production; the session token travels on it');
  }
  return { nodeEnv: raw.NODE_ENV, logLevel: raw.LOG_LEVEL, buildSha: raw.BUILD_SHA, apiOrigin, sideoutOrigin: raw.SIDEOUT_ORIGIN?.replace(/\/+$/, ''), secureCookies: production };
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
