import { describe, expect, it } from 'vitest';

import { DEVELOPMENT_SECRET_KEY, EnvError, loadEnv, requireMigratorUrl } from '../src/env';

const DEV_URL = 'postgres://purse_app:secret@localhost:5432/purse';
const TEST_URL = 'postgres://purse_app:secret@localhost:5432/purse_test';

describe('env', () => {
  it('uses the development URL outside tests', () => {
    const env = loadEnv({ NODE_ENV: 'development', PURSE_DATABASE_URL: DEV_URL, PURSE_DATABASE_URL_TEST: TEST_URL });
    expect(env.databaseUrl).toBe(DEV_URL);
    expect(env.port).toBe(4000);
    expect(env.logLevel).toBe('info');
  });

  it('uses only the _TEST URL under NODE_ENV=test', () => {
    const env = loadEnv({ NODE_ENV: 'test', PURSE_DATABASE_URL: DEV_URL, PURSE_DATABASE_URL_TEST: TEST_URL });
    expect(env.databaseUrl).toBe(TEST_URL);
    expect(() => loadEnv({ NODE_ENV: 'test', PURSE_DATABASE_URL: DEV_URL })).toThrow(/PURSE_DATABASE_URL_TEST/);
  });

  it('rejects non-postgres URLs and bad ports', () => {
    expect(() => loadEnv({ PURSE_DATABASE_URL: 'mysql://x/y' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, PORT: '99999' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, LOG_LEVEL: 'loud' })).toThrow(EnvError);
  });

  it('coerces PORT and passes BUILD_SHA through', () => {
    const env = loadEnv({ PURSE_DATABASE_URL: DEV_URL, PORT: '8080', BUILD_SHA: 'deadbeef' });
    expect(env.port).toBe(8080);
    expect(env.buildSha).toBe('deadbeef');
  });

  it('resolves the migrator URL per NODE_ENV and only the scripts require it', () => {
    const MIGRATOR = 'postgres://purse_migrator:secret@localhost:5432/purse';
    const MIGRATOR_TEST = 'postgres://purse_migrator:secret@localhost:5432/purse_test';
    const dev = loadEnv({ PURSE_DATABASE_URL: DEV_URL, PURSE_MIGRATOR_DATABASE_URL: MIGRATOR, PURSE_MIGRATOR_DATABASE_URL_TEST: MIGRATOR_TEST });
    expect(dev.migratorDatabaseUrl).toBe(MIGRATOR);
    expect(requireMigratorUrl(dev)).toBe(MIGRATOR);

    const test = loadEnv({ NODE_ENV: 'test', PURSE_DATABASE_URL_TEST: TEST_URL, PURSE_MIGRATOR_DATABASE_URL: MIGRATOR, PURSE_MIGRATOR_DATABASE_URL_TEST: MIGRATOR_TEST });
    expect(test.migratorDatabaseUrl).toBe(MIGRATOR_TEST);

    // The API process runs without it; a migrate/seed/reset asks for it by name.
    const runtimeOnly = loadEnv({ PURSE_DATABASE_URL: DEV_URL });
    expect(runtimeOnly.migratorDatabaseUrl).toBeUndefined();
    expect(() => requireMigratorUrl(runtimeOnly)).toThrow(/PURSE_MIGRATOR_DATABASE_URL is required/);
    expect(() => requireMigratorUrl(loadEnv({ NODE_ENV: 'test', PURSE_DATABASE_URL_TEST: TEST_URL }))).toThrow(
      /PURSE_MIGRATOR_DATABASE_URL_TEST is required/,
    );
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, PURSE_MIGRATOR_DATABASE_URL: 'mysql://x/y' })).toThrow(EnvError);
  });

  it('accepts an internal API token only when it is long enough', () => {
    expect(loadEnv({ PURSE_DATABASE_URL: DEV_URL }).internalApiToken).toBeUndefined();
    expect(loadEnv({ PURSE_DATABASE_URL: DEV_URL, INTERNAL_API_TOKEN: 'a-token-of-sixteen-chars' }).internalApiToken).toBe(
      'a-token-of-sixteen-chars',
    );
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, INTERNAL_API_TOKEN: 'short' })).toThrow(EnvError);
  });

  it('selects the provider seams, reads the dev identity lists, and sizes the rate limit', () => {
    const defaults = loadEnv({ PURSE_DATABASE_URL: DEV_URL });
    expect(defaults.providers).toEqual({ identity: 'dev', geo: 'dev', risk: 'dev', funding: 'dev', allowDevProviders: false, devIdentity: { allow: [], deny: [], pending: [] } });
    expect(defaults.rateLimit).toEqual({ burst: 100, perSecond: 20 });
    expect(defaults.trustedProxyHops).toBe(0);
    const configured = loadEnv({
      PURSE_DATABASE_URL: DEV_URL,
      ALLOW_DEV_PROVIDERS: 'true',
      DEV_IDENTITY_ALLOW: 'vip, staff',
      DEV_IDENTITY_DENY: 'banned',
      DEV_IDENTITY_PENDING: '',
      RATE_LIMIT_BURST: '10',
      RATE_LIMIT_PER_SECOND: '2.5',
      TRUSTED_PROXY_HOPS: '1',
    });
    expect(configured.providers.allowDevProviders).toBe(true);
    expect(configured.providers.devIdentity).toEqual({ allow: ['vip', 'staff'], deny: ['banned'], pending: [] });
    expect(configured.rateLimit).toEqual({ burst: 10, perSecond: 2.5 });
    expect(configured.trustedProxyHops).toBe(1);
    // Only implementations that exist can be named; a vendor is added in env.ts and src/providers.
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, IDENTITY_PROVIDER: 'persona' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, ALLOW_DEV_PROVIDERS: 'yes' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, RATE_LIMIT_BURST: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, TRUSTED_PROXY_HOPS: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, TRUSTED_PROXY_HOPS: '1.5' })).toThrow(EnvError);
  });

  it('derives the process secret, requiring a real one in production, and the embed SMS seam', () => {
    const dev = loadEnv({ PURSE_DATABASE_URL: DEV_URL });
    expect(dev.secretKey).toBe(DEVELOPMENT_SECRET_KEY);
    expect(dev.secretKeyIsDefault).toBe(true);
    expect(dev.embed).toEqual({ smsProvider: 'log', staticDir: undefined });
    expect(dev.webhooks).toEqual({ dispatcher: true, pollIntervalMs: 1000, deliveryTimeoutMs: 10_000, allowedHosts: [], allowedPorts: [] });
    const configured = loadEnv({ PURSE_DATABASE_URL: DEV_URL, PURSE_SECRET_KEY: 'x'.repeat(40), EMBED_SMS_PROVIDER: 'none', PURSE_EMBED_DIR: '/srv/embed', WEBHOOK_DISPATCHER: 'off', WEBHOOK_POLL_INTERVAL_MS: '250', WEBHOOK_DELIVERY_TIMEOUT_MS: '5000' });
    expect(configured.secretKey).toBe('x'.repeat(40));
    expect(configured.secretKeyIsDefault).toBe(false);
    expect(configured.embed).toEqual({ smsProvider: 'none', staticDir: '/srv/embed' });
    expect(configured.webhooks).toEqual({ dispatcher: false, pollIntervalMs: 250, deliveryTimeoutMs: 5000, allowedHosts: [], allowedPorts: [] });
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, PURSE_SECRET_KEY: 'short' })).toThrow(EnvError);
    expect(() => loadEnv({ NODE_ENV: 'production', PURSE_DATABASE_URL: DEV_URL })).toThrow(/PURSE_SECRET_KEY is required/);
    expect(() => loadEnv({ NODE_ENV: 'production', PURSE_DATABASE_URL: DEV_URL, PURSE_SECRET_KEY: 'x'.repeat(40), EMBED_SMS_PROVIDER: 'log' })).toThrow(/EMBED_SMS_PROVIDER=log is refused/);
    const production = loadEnv({ NODE_ENV: 'production', PURSE_DATABASE_URL: DEV_URL, PURSE_SECRET_KEY: 'x'.repeat(40) });
    expect(production.embed.smsProvider).toBe('none');
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, WEBHOOK_POLL_INTERVAL_MS: '10' })).toThrow(EnvError);
  });

  it('reads the webhook destination escape hatch, empty unless a deployment names something', () => {
    // Empty by default in every environment, so nothing is exempt from destination validation.
    expect(loadEnv({ NODE_ENV: 'production', PURSE_DATABASE_URL: DEV_URL, PURSE_SECRET_KEY: 'x'.repeat(40) }).webhooks.allowedHosts).toEqual([]);
    const hatch = loadEnv({ PURSE_DATABASE_URL: DEV_URL, WEBHOOK_ALLOWED_HOSTS: 'localhost, 127.0.0.1 ,[::1], Receiver.Internal', WEBHOOK_ALLOWED_PORTS: '443,8443' });
    expect(hatch.webhooks.allowedHosts).toEqual(['localhost', '127.0.0.1', '::1', 'receiver.internal']);
    expect(hatch.webhooks.allowedPorts).toEqual([443, 8443]);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, WEBHOOK_ALLOWED_PORTS: 'https' })).toThrow(/WEBHOOK_ALLOWED_PORTS/);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, WEBHOOK_ALLOWED_PORTS: '70000' })).toThrow(/WEBHOOK_ALLOWED_PORTS/);
  });
});
