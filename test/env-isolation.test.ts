import { describe, expect, it } from 'vitest';

import { loadEnv as loadPurseEnv } from '../apps/purse/src/env';
import { loadEnv as loadSideoutEnv } from '../apps/sideout/src/env';

/**
 * Decision D2: the two connection strings are never both loaded into one process. Each
 * app's env module is the only thing that hands a URL to `connect`, so the proof is
 * behavioural: give each loader an environment that carries both apps' strings and check
 * that the `Env` it returns holds its own and nothing of the other's, and that the other's
 * strings alone are not enough for it to start.
 */
const PURSE_URLS = {
  PURSE_DATABASE_URL: 'postgres://purse_app:purse-secret@db.internal:5432/purse',
  PURSE_DATABASE_URL_TEST: 'postgres://purse_app:purse-secret@db.internal:5432/purse_test',
};

const SIDEOUT_URLS = {
  SIDEOUT_DATABASE_URL: 'postgres://sideout_app:sideout-secret@db.internal:5432/sideout',
  SIDEOUT_DATABASE_URL_TEST: 'postgres://sideout_app:sideout-secret@db.internal:5432/sideout_test',
};

const BOTH = { ...PURSE_URLS, ...SIDEOUT_URLS };

/** Every string value anywhere in the returned Env, so a nested field could not hide one. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(stringsIn);
}

describe.each(['development', 'test'] as const)('under NODE_ENV=%s', (NODE_ENV) => {
  const ownPurseUrl = NODE_ENV === 'test' ? PURSE_URLS.PURSE_DATABASE_URL_TEST : PURSE_URLS.PURSE_DATABASE_URL;
  const ownSideoutUrl =
    NODE_ENV === 'test' ? SIDEOUT_URLS.SIDEOUT_DATABASE_URL_TEST : SIDEOUT_URLS.SIDEOUT_DATABASE_URL;

  it('Purse resolves its own connection string and carries none of Sideout’s', () => {
    const env = loadPurseEnv({ ...BOTH, NODE_ENV });
    expect(env.databaseUrl).toBe(ownPurseUrl);
    for (const url of Object.values(SIDEOUT_URLS)) expect(stringsIn(env)).not.toContain(url);
  });

  it('Sideout resolves its own connection string and carries none of Purse’s', () => {
    const env = loadSideoutEnv({ ...BOTH, NODE_ENV });
    expect(env.databaseUrl).toBe(ownSideoutUrl);
    for (const url of Object.values(PURSE_URLS)) expect(stringsIn(env)).not.toContain(url);
  });

  it('neither app can start on the other’s connection strings alone', () => {
    expect(() => loadPurseEnv({ ...SIDEOUT_URLS, NODE_ENV })).toThrow(/PURSE_DATABASE_URL/);
    expect(() => loadSideoutEnv({ ...PURSE_URLS, NODE_ENV })).toThrow(/SIDEOUT_DATABASE_URL/);
  });
});
