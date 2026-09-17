import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@purse/types';
import { SDK_VERSION } from '@purse/sdk';
import { readMigrationJournal } from '@repo/db';

import { env } from '../src/env';
import { MIGRATIONS_FOLDER } from '../src/paths';
import type { HealthReport } from '../src/routes/health';
import { harness, type TestHarness } from './helpers';

describe('GET /health', () => {
  let h: TestHarness;
  beforeAll(() => {
    h = harness({ sha: 'abc123' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('returns the documented envelope against a migrated database', async () => {
    const res = await h.app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: HealthReport };
    const journal = await readMigrationJournal(MIGRATIONS_FOLDER);

    expect(body).toEqual({
      data: {
        sha: 'abc123',
        migrations: { applied: journal.entries.length, available: journal.entries.length, pending: 0 },
        rulesetVersion: null,
        sdkVersion: SDK_VERSION,
        lastReconcile: null,
      },
    });
  });

  it('never leaks the connection string or credentials', async () => {
    const res = await h.app.request('/health');
    const text = await res.text();
    const url = new URL(env().databaseUrl);
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain(url.hostname);
    expect(text).not.toContain(url.username);
    if (url.password) expect(text).not.toContain(url.password);
  });

  it('echoes a well-formed caller request id and logs it', async () => {
    const res = await h.app.request('/health', { headers: { [REQUEST_ID_HEADER]: 'sideout-req-0001' } });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('sideout-req-0001');
    const line = h.lines.find((l) => l['msg'] === 'request' && l['requestId'] === 'sideout-req-0001');
    expect(line).toMatchObject({ service: 'purse-api-test', level: 'info', method: 'GET', path: '/health', status: 200 });
  });

  it('mints a request id when the caller sends none or garbage', async () => {
    const minted = await h.app.request('/health');
    expect(minted.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);

    const replaced = await h.app.request('/health', { headers: { [REQUEST_ID_HEADER]: 'bad id with spaces' } });
    expect(replaced.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports 503 in the error envelope when the database is unreachable', async () => {
    const broken = harness();
    await broken.database.close();
    const res = await broken.app.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { type: 'internal_error', code: 'database_unavailable', message: 'Database is unreachable' },
    });
  });
});

describe('envelope', () => {
  it('404s use the error envelope', async () => {
    const h = harness();
    try {
      const res = await h.app.request('/nope');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { type: 'invalid_request', code: 'not_found', message: 'No route for GET /nope' },
      });
    } finally {
      await h.close();
    }
  });
});
