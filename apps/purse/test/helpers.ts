import { createLogger, type Logger } from '@repo/logger';

import { createApp } from '../src/app';
import { connect, type ConnectOptions, type Database } from '../src/db/client';
import { logSmsSender, type SmsSender } from '../src/embed/sms';
import { DEVELOPMENT_SECRET_KEY, env, requireMigratorUrl } from '../src/env';
import type { RateLimitConfig, TokenBuckets } from '../src/http/rate-limit';
import { MIGRATIONS_FOLDER } from '../src/paths';
import { createProviders, type DevIdentityLists, type Providers } from '../src/providers';
import { deriveProcessKeys, type ProcessKeys } from '../src/secrets';
import { destinationPolicy, type DestinationPolicy } from '../src/webhooks';

/** The keys every test process derives, from the same stand-in `pnpm dev` uses. */
export const TEST_KEYS: ProcessKeys = deriveProcessKeys(DEVELOPMENT_SECRET_KEY);

/**
 * The webhook destination policy the tests run under: the escape hatch a developer or CI
 * uses (`WEBHOOK_ALLOWED_HOSTS`), naming the loopback hosts the sample receiver listens
 * on. Everything else is judged exactly as production judges it, which is what
 * `test/webhooks/destination.test.ts` and the refusal cases rely on.
 */
export const TEST_WEBHOOK_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;
export const TEST_WEBHOOK_POLICY: DestinationPolicy = destinationPolicy({ nodeEnv: 'test', allowedHosts: TEST_WEBHOOK_HOSTS });

export type TestHarness = {
  app: ReturnType<typeof createApp>['app'];
  buckets: TokenBuckets;
  providers: Providers;
  keys: ProcessKeys;
  sms: SmsSender;
  database: Database;
  logger: Logger;
  lines: Array<Record<string, unknown>>;
  close(): Promise<void>;
};

/** The runtime role's connection, which is what the code under test uses. */
export function connectRuntime(options: ConnectOptions = {}): Database {
  return connect(env().databaseUrl, { max: 2, applicationName: 'purse-test', ...options });
}

/** The owner role's connection, for fixtures and teardown that the runtime role is not allowed to do. */
export function connectMigrator(options: ConnectOptions = {}): Database {
  return connect(requireMigratorUrl(env()), { max: 1, applicationName: 'purse-test-migrator', ...options });
}

export type HarnessOptions = {
  sha?: string;
  internalApiToken?: string;
  rateLimit?: RateLimitConfig;
  trustedProxyHops?: number;
  sandboxSelfServe?: boolean;
  clock?: () => number;
  inProgressWaitMs?: number;
  statusTtlMs?: number;
  devIdentity?: DevIdentityLists;
  /** Replace one or more seams, for a test that needs a provider to misbehave. */
  providers?: Partial<Providers>;
  /** The embed sign-in's SMS seam; defaults to the log sender, which echoes codes. */
  sms?: SmsSender;
  /** Where the embed app is served from; defaults to none, so `/embed` answers 404 in tests. */
  embedDir?: string;
  /** Pool size; the HTTP tests that fire concurrent requests raise it. */
  max?: number;
  /** Which webhook destinations the app accepts; defaults to `TEST_WEBHOOK_POLICY`. */
  webhookPolicy?: DestinationPolicy;
};

/** A generous limit so functional tests never trip it; the rate-limit tests pass their own. */
export const TEST_RATE_LIMIT: RateLimitConfig = { burst: 10_000, perSecond: 10_000 };

/** An app wired to the test database (as the runtime role), the dev providers, and a logger that captures JSON lines in memory. */
export function harness(overrides: HarnessOptions = {}): TestHarness {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: 'purse-api-test',
    level: 'debug',
    write: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const database = connectRuntime(overrides.max === undefined ? {} : { max: overrides.max });
  const providers: Providers = {
    ...createProviders({ identity: 'dev', geo: 'dev', risk: 'dev', funding: 'dev', nodeEnv: 'test', allowDevProviders: false, ...(overrides.devIdentity === undefined ? {} : { devIdentity: overrides.devIdentity }) }),
    ...overrides.providers,
  };
  const sms = overrides.sms ?? logSmsSender(logger);
  const { app, buckets } = createApp({
    sql: database.sql,
    db: database.db,
    logger,
    migrationsFolder: MIGRATIONS_FOLDER,
    sha: overrides.sha ?? 'test-sha',
    nodeEnv: 'test',
    ...(overrides.sandboxSelfServe === undefined ? {} : { sandboxSelfServe: overrides.sandboxSelfServe }),
    internalApiToken: overrides.internalApiToken,
    providers,
    keys: TEST_KEYS,
    sms,
    embedDir: overrides.embedDir ?? '/nonexistent/purse-embed-out',
    webhookPolicy: overrides.webhookPolicy ?? TEST_WEBHOOK_POLICY,
    rateLimit: overrides.rateLimit ?? TEST_RATE_LIMIT,
    ...(overrides.trustedProxyHops === undefined ? {} : { trustedProxyHops: overrides.trustedProxyHops }),
    ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
    ...(overrides.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: overrides.inProgressWaitMs }),
    ...(overrides.statusTtlMs === undefined ? {} : { statusTtlMs: overrides.statusTtlMs }),
  });
  return { app, buckets, providers, keys: TEST_KEYS, sms, database, logger, lines, close: () => database.close() };
}

/** Await a promise that is expected to reject, returning the rejection. Fails when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}
