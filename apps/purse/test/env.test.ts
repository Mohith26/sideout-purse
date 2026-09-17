import { describe, expect, it } from 'vitest';

import { EnvError, loadEnv } from '../src/env';

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
});
