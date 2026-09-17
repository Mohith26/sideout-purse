import { describe, expect, it } from 'vitest';

import { EnvError, loadEnv } from '../src/env';

const DEV_URL = 'postgres://sideout_app:secret@localhost:5432/sideout';
const TEST_URL = 'postgres://sideout_app:secret@localhost:5432/sideout_test';

describe('env', () => {
  it('uses only the _TEST URL under NODE_ENV=test', () => {
    expect(loadEnv({ NODE_ENV: 'test', SIDEOUT_DATABASE_URL: DEV_URL, SIDEOUT_DATABASE_URL_TEST: TEST_URL }).databaseUrl).toBe(TEST_URL);
    expect(() => loadEnv({ NODE_ENV: 'test', SIDEOUT_DATABASE_URL: DEV_URL })).toThrow(/SIDEOUT_DATABASE_URL_TEST/);
  });

  it('uses the development URL otherwise and passes BUILD_SHA through', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).databaseUrl).toBe(DEV_URL);
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).buildSha).toBeUndefined();
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, BUILD_SHA: 'deadbeef' }).buildSha).toBe('deadbeef');
  });

  it('rejects non-postgres URLs', () => {
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: 'https://example.com' })).toThrow(EnvError);
  });
});
