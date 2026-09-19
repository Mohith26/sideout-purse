import { describe, expect, it } from 'vitest';

import { demoAccountsFor } from '../next.config';
import { DEVELOPMENT_SESSION_SECRET, EnvError, loadEnv } from '../src/env';
import { switchFrom } from '../src/lib/switch';

const DEV_URL = 'postgres://sideout_app:secret@localhost:5432/sideout';
const TEST_URL = 'postgres://sideout_app:secret@localhost:5432/sideout_test';
const PURSE = {
  PURSE_API_URL: 'https://purse.example',
  SIDEOUT_PURSE_SECRET_KEY: `sk_live_${'K'.repeat(32)}`,
  PURSE_WEBHOOK_SECRET: 'whsec_' + 'w'.repeat(32),
  NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: `pk_live_${'P'.repeat(32)}`,
  NEXT_PUBLIC_PURSE_TENANT_ID: 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9',
};
const PRODUCTION = { NODE_ENV: 'production', SIDEOUT_DATABASE_URL: DEV_URL, SESSION_SECRET: 's'.repeat(32), ...PURSE };

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

  it('reads the reservation TTL in minutes, defaulting to 30, and refuses nonsense', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).reservationTtlMs).toBe(30 * 60_000);
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, RESERVATION_TTL_MINUTES: '5' }).reservationTtlMs).toBe(5 * 60_000);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, RESERVATION_TTL_MINUTES: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, RESERVATION_TTL_MINUTES: 'soon' })).toThrow(EnvError);
  });

  it('reads the sign-in code budget, defaulting to 600 per ten minutes, and refuses nonsense', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).authCodeGlobalCap).toBe(600);
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, AUTH_CODE_GLOBAL_CAP: '50' }).authCodeGlobalCap).toBe(50);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, AUTH_CODE_GLOBAL_CAP: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, AUTH_CODE_GLOBAL_CAP: 'lots' })).toThrow(EnvError);
  });

  it('reads the Purse variables, defaults them locally, requires every one in production, and checks their shapes', () => {
    const dev = loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL });
    expect(dev.purse).toEqual({ apiUrl: 'http://localhost:4000', secretKey: undefined, webhookSecret: undefined, publishableKey: undefined, browserOrigin: 'http://localhost:4000', tenantId: 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9' });
    const configured = loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, ...PURSE, PURSE_API_URL: 'http://purse.internal:4000/', NEXT_PUBLIC_PURSE_ORIGIN: 'https://purse.example' });
    expect(configured.purse).toMatchObject({ apiUrl: 'http://purse.internal:4000', browserOrigin: 'https://purse.example', secretKey: PURSE.SIDEOUT_PURSE_SECRET_KEY, publishableKey: PURSE.NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY });
    expect(loadEnv(PRODUCTION).purse.browserOrigin).toBe('https://purse.example');
    const { SIDEOUT_PURSE_SECRET_KEY: _omitted, ...withoutKey } = PRODUCTION;
    expect(() => loadEnv(withoutKey)).toThrow(/SIDEOUT_PURSE_SECRET_KEY is required in production/);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, SIDEOUT_PURSE_SECRET_KEY: 'pk_sandbox_' + 'A'.repeat(32) })).toThrow(EnvError);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: 'sk_sandbox_' + 'A'.repeat(32) })).toThrow(EnvError);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, NEXT_PUBLIC_PURSE_TENANT_ID: 'usr_x' })).toThrow(EnvError);
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, PURSE_API_URL: 'ftp://purse' })).toThrow(EnvError);
    // An exported but empty variable is an unset one.
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, SIDEOUT_PURSE_SECRET_KEY: '', PURSE_API_URL: '' }).purse.secretKey).toBeUndefined();
  });

  it('requires the two Stripe variables together and selects the provider accordingly', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).stripe).toBeUndefined();
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, STRIPE_WEBHOOK_SECRET: 'whsec' })).toThrow(/set together/);
    const configured = loadEnv({ ...PRODUCTION, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    expect(configured.stripe).toEqual({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
    expect(configured.donationProvider).toBe('stripe');
    expect(loadEnv(PRODUCTION).donationProvider).toBe('none');
  });

  it('exposes the optional Stripe publishable key to the browser side and refuses one of the wrong shape', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).stripePublishableKey).toBeUndefined();
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123' }).stripePublishableKey).toBe('pk_test_abc123');
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'sk_test_abc123' })).toThrow(/publishable key/);
  });

  describe('DEMO_ACCOUNTS (docs/demo-accounts.md)', () => {
    const SANDBOX = { ...PRODUCTION, SIDEOUT_PURSE_SECRET_KEY: `sk_sandbox_${'K'.repeat(32)}`, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: `pk_sandbox_${'P'.repeat(32)}` };

    it('is off by default, on for true or 1 only, and reported on the environment', () => {
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).demoAccounts).toBe(false);
      expect(loadEnv(SANDBOX).demoAccounts).toBe(false);
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, DEMO_ACCOUNTS: 'true' }).demoAccounts).toBe(true);
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, DEMO_ACCOUNTS: '1' }).demoAccounts).toBe(true);
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, DEMO_ACCOUNTS: 'yes' }).demoAccounts).toBe(false);
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, DEMO_ACCOUNTS: '' }).demoAccounts).toBe(false);
      expect(loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true' }).demoAccounts).toBe(true);
      expect(switchFrom(' TRUE ')).toBe(true);
      expect(switchFrom(undefined)).toBe(false);
    });

    it('is refused beside anything that is not demo-safe: a live Purse key, a live Stripe key', () => {
      expect(() => loadEnv({ ...PRODUCTION, DEMO_ACCOUNTS: 'true' })).toThrow(/demo-safe providers .*SIDEOUT_PURSE_SECRET_KEY is a live key/);
      expect(() => loadEnv({ ...SANDBOX, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: PURSE.NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY, DEMO_ACCOUNTS: 'true' })).toThrow(/NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY is a live key/);
      expect(() => loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toThrow(/STRIPE_SECRET_KEY is not a test-mode key/);
      expect(() => loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).toThrow(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a live key/);
      // Test-mode Stripe keys are demo-safe, and a configured Stripe still wins over the dev provider.
      const withStripe = loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_x' });
      expect(withStripe.demoAccounts).toBe(true);
      expect(withStripe.donationProvider).toBe('stripe');
      // The log SMS sender is demo-safe outside production; production never runs it (and never a real one either, today).
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, DEMO_ACCOUNTS: 'true', SMS_PROVIDER: 'log' }).smsProvider).toBe('log');
    });

    it('lets production run the dev donation provider under the switch, and only under it', () => {
      expect(loadEnv(SANDBOX).donationProvider).toBe('none');
      expect(loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true' }).donationProvider).toBe('dev');
      expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).donationProvider).toBe('dev');
    });

    it('refuses a build made for the other setting, and takes an unset build value as "as the server"', () => {
      expect(() => loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true' }, 'false')).toThrow(/NEXT_PUBLIC_DEMO_ACCOUNTS was false at build time but DEMO_ACCOUNTS is true/);
      expect(() => loadEnv(SANDBOX, 'true')).toThrow(/NEXT_PUBLIC_DEMO_ACCOUNTS was true at build time but DEMO_ACCOUNTS is false/);
      expect(loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true' }, 'true').demoAccounts).toBe(true);
      expect(loadEnv(SANDBOX, 'false').demoAccounts).toBe(false);
      expect(loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true' }, undefined).demoAccounts).toBe(true);
      expect(loadEnv({ ...SANDBOX, DEMO_ACCOUNTS: 'true' }, '').demoAccounts).toBe(true);
      // What next.config.ts inlines, derived from the same switch.
      expect(demoAccountsFor('true')).toBe('true');
      expect(demoAccountsFor('1')).toBe('true');
      expect(demoAccountsFor(undefined)).toBe('false');
      expect(demoAccountsFor('no')).toBe('false');
    });
  });
});
