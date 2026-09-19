import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@purse/types';
import { SDK_VERSION } from '@purse/sdk';
import { readMigrationJournal } from '@repo/db';

import { GET } from '../src/app/health/route';
import { buildSha } from '../src/build-info';
import { env } from '../src/env';
import { probePurse, type HealthReport } from '../src/health/report';
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
        // Off by default (`DEMO_ACCOUNTS`); the deployed demo reports true.
        demoAccounts: false,
        // The suite runs with no secret key, so Purse is not asked (`purse_unavailable` elsewhere, `not_configured` here).
        purse: { reachable: false, reason: 'not_configured' },
      },
    });
    expect(typeof body.data.sha).toBe('string');
    expect(body.data.sha.length).toBeGreaterThan(0);
  });

  it('relays what Purse says about itself, and reports a Purse that cannot be asked without failing', async () => {
    const answer = (status: number, body: unknown): typeof fetch => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    const clean = { data: { status: 'ok', sha: 'x', migrations: { applied: 1, available: 1, pending: 0 }, rulesetVersion: '2026.09.1', sdkVersion: SDK_VERSION, reconcile: { ok: true, source: 'schedule', ranAt: '2026-09-18T10:00:00.000Z', durationMs: 12, failed: [] } } };
    expect(await probePurse({ apiUrl: 'http://purse.test', fetch: answer(200, clean) })).toEqual({ reachable: true, status: 'ok', rulesetVersion: '2026.09.1', reconcile: { ok: true, ranAt: '2026-09-18T10:00:00.000Z', failed: [] } });
    const failing = { data: { ...clean.data, status: 'failing', reconcile: { ...clean.data.reconcile, ok: false, failed: ['I1'] } } };
    expect(await probePurse({ apiUrl: 'http://purse.test', fetch: answer(503, failing) })).toMatchObject({ reachable: true, status: 'failing', reconcile: { ok: false, failed: ['I1'] } });
    expect(await probePurse({ apiUrl: 'http://purse.test', fetch: answer(200, { data: { ...clean.data, reconcile: null } }) })).toMatchObject({ reachable: true, reconcile: null });
    expect(await probePurse({ apiUrl: 'http://purse.test', fetch: answer(502, 'bad gateway') })).toEqual({ reachable: false, reason: 'unexpected_answer' });
    expect(await probePurse({ apiUrl: 'http://purse.test', fetch: answer(200, { data: { hello: 1 } }) })).toEqual({ reachable: false, reason: 'unexpected_answer' });
    expect(await probePurse({ apiUrl: 'http://purse.test', fetch: () => Promise.reject(new Error('ECONNREFUSED')) })).toEqual({ reachable: false, reason: 'unreachable' });
    expect(await probePurse({ apiUrl: undefined })).toEqual({ reachable: false, reason: 'not_configured' });
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
