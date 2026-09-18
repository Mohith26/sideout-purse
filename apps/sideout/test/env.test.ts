import { describe, expect, it } from 'vitest';

import { DEVELOPMENT_SESSION_SECRET, EnvError, loadEnv } from '../src/env';

const DEV_URL = 'postgres://sideout_app:secret@localhost:5432/sideout';
const TEST_URL = 'postgres://sideout_app:secret@localhost:5432/sideout_test';
const PRODUCTION = { NODE_ENV: 'production', SIDEOUT_DATABASE_URL: DEV_URL, SESSION_SECRET: 's'.repeat(32) };

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

  it('defaults the session secret and log SMS sender outside production, and refuses both in production', () => {
    const dev = loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL });
    expect(dev.sessionSecret).toBe(DEVELOPMENT_SESSION_SECRET);
    expect(dev.smsProvider).toBe('log');
    expect(dev.trustedProxyHops).toBe(0);
    expect(() => loadEnv({ NODE_ENV: 'production', SIDEOUT_DATABASE_URL: DEV_URL })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...PRODUCTION, SESSION_SECRET: 'short' })).toThrow(EnvError);
    expect(() => loadEnv({ ...PRODUCTION, SMS_PROVIDER: 'log' })).toThrow(/SMS_PROVIDER=log/);
    const production = loadEnv({ ...PRODUCTION, TRUSTED_PROXY_HOPS: '1' });
    expect(production.smsProvider).toBe('none');
    expect(production.trustedProxyHops).toBe(1);
    expect(production.sessionSecret).toBe('s'.repeat(32));
  });

  it('requires the two Stripe variables together and selects the provider accordingly', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).stripe).toBeUndefined();
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, STRIPE_WEBHOOK_SECRET: 'whsec' })).toThrow(/set together/);
    const configured = loadEnv({ ...PRODUCTION, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    expect(configured.stripe).toEqual({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
    expect(configured.donationProvider).toBe('stripe');
    expect(loadEnv(PRODUCTION).donationProvider).toBe('none');
  });
});
