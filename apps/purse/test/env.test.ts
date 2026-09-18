import { describe, expect, it } from 'vitest';

import { EnvError, loadEnv, requireMigratorUrl } from '../src/env';

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
    expect(defaults.providers).toEqual({ identity: 'dev', geo: 'dev', risk: 'dev', allowDevProviders: false, devIdentity: { allow: [], deny: [], pending: [] } });
    expect(defaults.rateLimit).toEqual({ burst: 100, perSecond: 20 });
    const configured = loadEnv({
      PURSE_DATABASE_URL: DEV_URL,
      ALLOW_DEV_PROVIDERS: 'true',
      DEV_IDENTITY_ALLOW: 'vip, staff',
      DEV_IDENTITY_DENY: 'banned',
      DEV_IDENTITY_PENDING: '',
      RATE_LIMIT_BURST: '10',
      RATE_LIMIT_PER_SECOND: '2.5',
    });
    expect(configured.providers.allowDevProviders).toBe(true);
    expect(configured.providers.devIdentity).toEqual({ allow: ['vip', 'staff'], deny: ['banned'], pending: [] });
    expect(configured.rateLimit).toEqual({ burst: 10, perSecond: 2.5 });
    // Only implementations that exist can be named; a vendor is added in env.ts and src/providers.
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, IDENTITY_PROVIDER: 'persona' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, ALLOW_DEV_PROVIDERS: 'yes' })).toThrow(EnvError);
    expect(() => loadEnv({ PURSE_DATABASE_URL: DEV_URL, RATE_LIMIT_BURST: '0' })).toThrow(EnvError);
  });
});
