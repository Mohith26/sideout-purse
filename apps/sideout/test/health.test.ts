import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@purse/types';
import { SDK_VERSION } from '@purse/sdk';
import { readMigrationJournal } from '@repo/db';

import { GET } from '../src/app/health/route';
import { buildSha } from '../src/build-info';
import { env } from '../src/env';
import type { HealthReport } from '../src/health/report';
import { migrationsFolder } from '../src/paths';

describe('GET /health', () => {
  it('returns the documented envelope against a migrated database', async () => {
    const res = await GET(new Request('http://sideout.test/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: HealthReport };
    const journal = await readMigrationJournal(migrationsFolder());

    expect(body).toEqual({
      data: {
        sha: buildSha(env().buildSha),
        migrations: { applied: journal.entries.length, available: journal.entries.length, pending: 0 },
        purseSdkVersion: SDK_VERSION,
      },
    });
    expect(typeof body.data.sha).toBe('string');
    expect(body.data.sha.length).toBeGreaterThan(0);
  });

  it('never leaks the connection string or credentials', async () => {
    const res = await GET(new Request('http://sideout.test/health'));
    const text = await res.text();
    const url = new URL(env().databaseUrl);
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain(url.hostname);
    expect(text).not.toContain(url.username);
    if (url.password) expect(text).not.toContain(url.password);
  });

  it('echoes a well-formed request id and mints one otherwise', async () => {
    const echoed = await GET(new Request('http://sideout.test/health', { headers: { [REQUEST_ID_HEADER]: 'trace-abc-123' } }));
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe('trace-abc-123');

    const minted = await GET(new Request('http://sideout.test/health', { headers: { [REQUEST_ID_HEADER]: 'no spaces allowed' } }));
    expect(minted.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
