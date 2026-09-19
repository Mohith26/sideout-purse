import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATUS_RUN_HISTORY, type PublicStatusResource } from '@purse/types';
import { SDK_VERSION } from '@purse/sdk';
import { readMigrationJournal } from '@repo/db';

import { env } from '../src/env';
import { reconcileRuns } from '../src/db/schema';
import { INVARIANTS, reconcile, recordReconcileRun, type ReconcileReport } from '../src/ledger';
import { MIGRATIONS_FOLDER } from '../src/paths';
import { connectMigrator, harness, type TestHarness } from './helpers';

/**
 * `GET /status` (spec section 12, stretch item 5): the stored reconcile record as a public,
 * cached, address-rate-limited feed. It never runs `reconcile()`, never answers 503 for a
 * failed run, and carries no detail sentence, balance, name or count.
 */
describe('GET /status', () => {
  let now = Date.parse('2026-09-19T10:00:00.000Z');
  let h: TestHarness;
  let clean: ReconcileReport;

  const read = async (path = '/status'): Promise<{ status: number; headers: Headers; body: PublicStatusResource }> => {
    const res = await h.app.request(path, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    return { status: res.status, headers: res.headers, body: ((await res.json()) as { data: PublicStatusResource }).data };
  };

  beforeAll(async () => {
    const migrator = connectMigrator();
    try {
      await migrator.db.delete(reconcileRuns);
    } finally {
      await migrator.close();
    }
    h = harness({ sha: 'abc123', statusTtlMs: 30_000, clock: () => now, rateLimit: { burst: 3, perSecond: 1 }, trustedProxyHops: 1 });
    clean = await reconcile(h.database.db);
    expect(clean.ok).toBe(true);
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists every invariant as unknown before the first run, with the build facts /health reports', async () => {
    const { status, headers, body } = await read();
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('public, max-age=30');
    const journal = await readMigrationJournal(MIGRATIONS_FOLDER);
    expect(body).toEqual({
      status: 'unknown',
      sha: 'abc123',
      migrations: { applied: journal.entries.length, available: journal.entries.length, pending: 0 },
      rulesetVersion: null,
      sdkVersion: SDK_VERSION,
      invariants: INVARIANTS.map((each) => ({ id: each.id, name: each.name, status: 'unknown' })),
      lastRun: null,
      runs: [],
      generatedAt: '2026-09-19T10:00:00.000Z',
    });
    expect(body.invariants).toHaveLength(7);
  });

  it('serves one assembled answer for the TTL, then the stored runs newest first, and never runs reconcile itself', async () => {
    await recordReconcileRun(h.database.db, { ...clean, ranAt: '2026-09-19T09:45:00.000Z' }, 'schedule');
    // Still the cached answer: the run recorded a moment ago is not visible until the TTL passes.
    expect((await read()).body.status).toBe('unknown');
    now += 30_000;
    const fresh = await read();
    expect(fresh.body.status).toBe('ok');
    expect(fresh.body.generatedAt).toBe('2026-09-19T10:00:30.000Z');
    expect(fresh.body.lastRun).toEqual({ ok: true, source: 'schedule', ranAt: '2026-09-19T09:45:00.000Z', durationMs: clean.durationMs, failed: [] });
    expect(fresh.body.runs).toEqual([fresh.body.lastRun]);
    expect(fresh.body.invariants.every((each) => each.status === 'ok')).toBe(true);

    // Reading the feed recorded nothing: the count of runs is what the tests wrote.
    const [count] = await h.database.sql`select count(*)::int as n from reconcile_runs`;
    expect(count?.['n']).toBe(1);
  });

  it('names a failing invariant by id and name only, answers 200, and hides every detail sentence', async () => {
    const broken: ReconcileReport = {
      ...clean,
      ok: false,
      ranAt: '2026-09-19T10:00:00.000Z',
      invariants: clean.invariants.map((each) => (each.id === 'I3' ? { ...each, ok: false, status: 'failed' as const, detail: 'wallet acct_secret-wallet-id of user usr_secret holds -125 POINTS' } : each)),
    };
    await recordReconcileRun(h.database.db, broken, 'console');
    now += 30_000;
    const res = await h.app.request('/v1/status', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = (JSON.parse(text) as { data: PublicStatusResource }).data;
    expect(body.status).toBe('failing');
    expect(body.lastRun).toMatchObject({ ok: false, source: 'console', failed: ['I3'] });
    expect(body.invariants.find((each) => each.id === 'I3')).toEqual({ id: 'I3', name: 'no user wallet is negative', status: 'failed' });
    expect(body.invariants.filter((each) => each.status === 'ok')).toHaveLength(6);
    expect(body.runs.map((each) => each.ranAt)).toEqual(['2026-09-19T10:00:00.000Z', '2026-09-19T09:45:00.000Z']);
    for (const run of body.runs) expect(Object.keys(run).sort()).toEqual(['durationMs', 'failed', 'ok', 'ranAt', 'source']);
    for (const invariant of body.invariants) expect(Object.keys(invariant).sort()).toEqual(['id', 'name', 'status']);
    // Nothing an invariant's detail quotes, and no connection string, reaches the wire.
    expect(text).not.toContain('detail');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('acct_');
    expect(text).not.toContain('usr_');
    expect(text).not.toContain('-125');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain(new URL(env().databaseUrl).hostname);
  });

  it('keeps the newest STATUS_RUN_HISTORY runs', async () => {
    for (let i = 1; i <= STATUS_RUN_HISTORY + 3; i += 1) {
      await recordReconcileRun(h.database.db, { ...clean, ranAt: new Date(Date.parse('2026-09-19T11:00:00.000Z') + i * 60_000).toISOString() }, 'cli');
    }
    now += 30_000;
    const { body } = await read();
    expect(body.runs).toHaveLength(STATUS_RUN_HISTORY);
    expect(body.runs[0]?.ranAt).toBe(new Date(Date.parse('2026-09-19T11:00:00.000Z') + (STATUS_RUN_HISTORY + 3) * 60_000).toISOString());
    expect(body.status).toBe('ok');
    expect(body.lastRun?.source).toBe('cli');
  });

  it('is rate limited by address and needs no key', async () => {
    now += 30_000;
    const hits: number[] = [];
    for (let i = 0; i < 4; i += 1) hits.push((await h.app.request('/status', { headers: { 'x-forwarded-for': '198.51.100.9' } })).status);
    expect(hits).toEqual([200, 200, 200, 429]);
    const limited = await h.app.request('/status', { headers: { 'x-forwarded-for': '198.51.100.9' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(((await limited.json()) as { error: { type: string; code: string } }).error).toMatchObject({ type: 'rate_limited', code: 'too_many_requests' });
    // Another address is unaffected, and a refill lets the first back in.
    expect((await h.app.request('/status', { headers: { 'x-forwarded-for': '198.51.100.10' } })).status).toBe(200);
    now += 1000;
    expect((await h.app.request('/status', { headers: { 'x-forwarded-for': '198.51.100.9' } })).status).toBe(200);
  });
});
