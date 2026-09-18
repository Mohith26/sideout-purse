import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@purse/types';
import { SDK_VERSION } from '@purse/sdk';
import { readMigrationJournal } from '@repo/db';

import { env } from '../src/env';
import { reconcileRuns } from '../src/db/schema';
import { recordReconcileRun, reconcile } from '../src/ledger';
import { MIGRATIONS_FOLDER } from '../src/paths';
import type { HealthReport } from '../src/routes/health';
import { connectMigrator, harness, rejection, type TestHarness } from './helpers';

describe('GET /health', () => {
  let h: TestHarness;
  beforeAll(() => {
    h = harness({ sha: 'abc123' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('returns the documented envelope against a migrated database', async () => {
    const migrator = connectMigrator();
    try {
      await migrator.db.delete(reconcileRuns);
    } finally {
      await migrator.close();
    }
    const res = await h.app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: HealthReport };
    const journal = await readMigrationJournal(MIGRATIONS_FOLDER);

    expect(body).toEqual({
      data: {
        status: 'ok',
        sha: 'abc123',
        migrations: { applied: journal.entries.length, available: journal.entries.length, pending: 0 },
        rulesetVersion: null,
        sdkVersion: SDK_VERSION,
        reconcile: null,
      },
    });
  });

  it('reports the last recorded reconcile run, and answers 503 while the last one failed', async () => {
    const clean = await reconcile(h.database.db);
    expect(clean.ok).toBe(true);
    await recordReconcileRun(h.database.db, clean, 'cli');
    const first = (await (await h.app.request('/health')).json()) as { data: HealthReport };
    expect(first.data.status).toBe('ok');
    expect(first.data.reconcile).toEqual({ ok: true, source: 'cli', ranAt: clean.ranAt, durationMs: clean.durationMs, failed: [] });

    // A later run that found a violation: what a broken ledger would record.
    const broken = { ...clean, ok: false, ranAt: new Date(Date.parse(clean.ranAt) + 1000).toISOString(), invariants: clean.invariants.map((each) => (each.id === 'I1' ? { ...each, ok: false, status: 'failed' as const, detail: 'POINTS: debits 10, credits 9' } : each)) };
    await recordReconcileRun(h.database.db, broken, 'schedule');
    const failing = await h.app.request('/health');
    expect(failing.status).toBe(503);
    const body = (await failing.json()) as { data: HealthReport };
    expect(body.data.status).toBe('failing');
    expect(body.data.reconcile).toMatchObject({ ok: false, source: 'schedule', failed: ['I1'] });
    expect(body.data.sha).toBe('abc123');
    expect(h.lines.find((l) => l['msg'] === 'health: last reconcile failed')).toMatchObject({ level: 'error', failed: ['I1'] });

    // The record is append-only for the runtime: a failed run cannot be rewritten or removed, only followed by a clean one.
    expect(String(await rejection(h.database.sql`delete from reconcile_runs`))).toMatch(/permission denied for table reconcile_runs/);
    expect(String(await rejection(h.database.sql`update reconcile_runs set ok = true, failed = '[]'::jsonb`))).toMatch(/permission denied for table reconcile_runs/);
    const again = await reconcile(h.database.db);
    await recordReconcileRun(h.database.db, { ...again, ranAt: new Date(Date.parse(broken.ranAt) + 1000).toISOString() }, 'internal');
    const recovered = (await (await h.app.request('/health')).json()) as { data: HealthReport };
    expect(recovered.data.status).toBe('ok');
    expect(recovered.data.reconcile).toMatchObject({ ok: true, source: 'internal' });
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

describe('public pages', () => {
  it('serves the responsible-play policy (with the limits anchor) and the support path without a key', async () => {
    const h = harness();
    try {
      const policy = await h.app.request('/responsible-play');
      expect(policy.status).toBe(200);
      expect(policy.headers.get('content-type')).toMatch(/text\/html/);
      const policyHtml = await policy.text();
      expect(policyHtml).toContain('id="limits"');
      expect(policyHtml).toContain('Self-exclusion');
      expect(policyHtml).not.toMatch(/sk_(sandbox|live)_/);
      const support = await h.app.request('/support');
      expect(support.status).toBe(200);
      expect(await support.text()).toContain('responsible-play');
    } finally {
      await h.close();
    }
  });
});
