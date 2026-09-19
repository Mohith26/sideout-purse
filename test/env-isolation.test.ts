import { describe, expect, it } from 'vitest';

import { loadEnv as loadPingpongEnv } from '../apps/pingpong/src/env';
import { loadEnv as loadPurseEnv } from '../apps/purse/src/env';
import { loadEnv as loadSideoutEnv } from '../apps/sideout/src/env';

/**
 * Decision D2: no two connection strings are ever loaded into one process. Each app's env
 * module is the only thing that hands a URL to `connect`, so the proof is behavioural:
 * give each loader an environment that carries every app's strings and check that the
 * `Env` it returns holds its own and nothing of the others', and that the others' strings
 * alone are not enough for it to start. Three apps since the second tenant.
 */
const PURSE_URLS = {
  PURSE_DATABASE_URL: 'postgres://purse_app:purse-secret@db.internal:5432/purse',
  PURSE_DATABASE_URL_TEST: 'postgres://purse_app:purse-secret@db.internal:5432/purse_test',
};

const SIDEOUT_URLS = {
  SIDEOUT_DATABASE_URL: 'postgres://sideout_app:sideout-secret@db.internal:5432/sideout',
  SIDEOUT_DATABASE_URL_TEST: 'postgres://sideout_app:sideout-secret@db.internal:5432/sideout_test',
};

const PINGPONG_URLS = {
  PINGPONG_DATABASE_URL: 'postgres://pingpong_app:pingpong-secret@db.internal:5432/pingpong',
  PINGPONG_DATABASE_URL_TEST: 'postgres://pingpong_app:pingpong-secret@db.internal:5432/pingpong_test',
};

const BOTH = { ...PURSE_URLS, ...SIDEOUT_URLS, ...PINGPONG_URLS };

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
  const ownPingpongUrl = NODE_ENV === 'test' ? PINGPONG_URLS.PINGPONG_DATABASE_URL_TEST : PINGPONG_URLS.PINGPONG_DATABASE_URL;

  it('Purse resolves its own connection string and carries none of the tenants’', () => {
    const env = loadPurseEnv({ ...BOTH, NODE_ENV });
    expect(env.databaseUrl).toBe(ownPurseUrl);
    for (const url of [...Object.values(SIDEOUT_URLS), ...Object.values(PINGPONG_URLS)]) expect(stringsIn(env)).not.toContain(url);
  });

  it('Sideout resolves its own connection string and carries none of Purse’s or the other tenant’s', () => {
    const env = loadSideoutEnv({ ...BOTH, NODE_ENV });
    expect(env.databaseUrl).toBe(ownSideoutUrl);
    for (const url of [...Object.values(PURSE_URLS), ...Object.values(PINGPONG_URLS)]) expect(stringsIn(env)).not.toContain(url);
  });

  it('Ping-pong resolves its own connection string and carries none of Purse’s or Sideout’s', () => {
    const env = loadPingpongEnv({ ...BOTH, NODE_ENV });
    expect(env.databaseUrl).toBe(ownPingpongUrl);
    for (const url of [...Object.values(PURSE_URLS), ...Object.values(SIDEOUT_URLS)]) expect(stringsIn(env)).not.toContain(url);
  });

  it('no app can start on the others’ connection strings alone', () => {
    expect(() => loadPurseEnv({ ...SIDEOUT_URLS, ...PINGPONG_URLS, NODE_ENV })).toThrow(/PURSE_DATABASE_URL/);
    expect(() => loadSideoutEnv({ ...PURSE_URLS, ...PINGPONG_URLS, NODE_ENV })).toThrow(/SIDEOUT_DATABASE_URL/);
    expect(() => loadPingpongEnv({ ...PURSE_URLS, ...SIDEOUT_URLS, NODE_ENV })).toThrow(/PINGPONG_DATABASE_URL/);
  });
});
