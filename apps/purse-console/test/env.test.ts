import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env';

describe('console env', () => {
  it('defaults to the local API and plain cookies outside production', () => {
    const env = loadEnv({});
    expect(env).toMatchObject({ nodeEnv: 'development', apiOrigin: 'http://localhost:4000', secureCookies: false });
  });

  it('requires https (or loopback) for the API origin in production and marks cookies Secure', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', PURSE_API_ORIGIN: 'http://purse.example' })).toThrow(/https/);
    expect(loadEnv({ NODE_ENV: 'production', PURSE_API_ORIGIN: 'https://purse.example/' })).toMatchObject({ apiOrigin: 'https://purse.example', secureCookies: true });
    expect(loadEnv({ NODE_ENV: 'production', PURSE_API_ORIGIN: 'http://127.0.0.1:4010' }).apiOrigin).toBe('http://127.0.0.1:4010');
  });

  it('refuses a malformed origin', () => {
    expect(() => loadEnv({ PURSE_API_ORIGIN: 'purse' })).toThrow(/Invalid environment/);
    expect(() => loadEnv({ SIDEOUT_ORIGIN: 'sideout' })).toThrow(/Invalid environment/);
  });

  it('takes the Sideout origin for the status page when one is set; exported but empty counts as unset', () => {
    expect(loadEnv({}).sideoutOrigin).toBeUndefined();
    expect(loadEnv({ SIDEOUT_ORIGIN: '' }).sideoutOrigin).toBeUndefined();
    expect(loadEnv({ SIDEOUT_ORIGIN: 'https://sideout.example/' }).sideoutOrigin).toBe('https://sideout.example');
  });
});
