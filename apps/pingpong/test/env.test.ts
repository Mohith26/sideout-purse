import { describe, expect, it } from 'vitest';

import { DEVELOPMENT_OFFICE_CODE, DEVELOPMENT_PURSE_TENANT_ID, loadEnv } from '../src/env';

const DB = { PINGPONG_DATABASE_URL: 'postgres://pingpong_app:x@db/pingpong', PINGPONG_DATABASE_URL_TEST: 'postgres://pingpong_app:x@db/pingpong_test' };
const KEY = `sk_sandbox_${'A'.repeat(32)}`;
const PK = `pk_sandbox_${'B'.repeat(32)}`;

describe('loadEnv', () => {
  it('runs outside production with defaults: the office code, the session secret, Purse off', () => {
    const env = loadEnv({ ...DB, NODE_ENV: 'development' });
    expect(env.officeCode).toBe(DEVELOPMENT_OFFICE_CODE);
    expect(env.purse.secretKey).toBeUndefined();
    expect(env.purse.apiUrl).toBe('http://localhost:4000');
    expect(env.purse.tenantId).toBe(DEVELOPMENT_PURSE_TENANT_ID);
    expect(env.databaseUrl).toBe(DB.PINGPONG_DATABASE_URL);
    expect(loadEnv({ ...DB, NODE_ENV: 'test' }).databaseUrl).toBe(DB.PINGPONG_DATABASE_URL_TEST);
  });

  it('treats an exported but empty variable as unset', () => {
    expect(loadEnv({ ...DB, NODE_ENV: 'development', PINGPONG_PURSE_SECRET_KEY: '', OFFICE_CODE: '' }).purse.secretKey).toBeUndefined();
  });

  it('requires the session secret, the office code and every Purse variable in production', () => {
    const base = { ...DB, NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(32), OFFICE_CODE: 'paddle-2026', PURSE_API_URL: 'https://purse.example', PINGPONG_PURSE_SECRET_KEY: KEY, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: PK, NEXT_PUBLIC_PURSE_TENANT_ID: DEVELOPMENT_PURSE_TENANT_ID };
    expect(loadEnv(base).officeCode).toBe('paddle-2026');
    expect(() => loadEnv({ ...base, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...base, OFFICE_CODE: undefined })).toThrow(/OFFICE_CODE/);
    expect(() => loadEnv({ ...base, PINGPONG_PURSE_SECRET_KEY: undefined })).toThrow(/PINGPONG_PURSE_SECRET_KEY/);
    expect(() => loadEnv({ ...base, OFFICE_CODE: 'short' })).toThrow(/OFFICE_CODE/);
  });

  it('refuses a malformed key and a non-http Purse URL', () => {
    expect(() => loadEnv({ ...DB, PINGPONG_PURSE_SECRET_KEY: 'sk_live_short' })).toThrow(/secret key/);
    expect(() => loadEnv({ ...DB, PURSE_API_URL: 'ftp://purse' })).toThrow(/http/);
  });
});
