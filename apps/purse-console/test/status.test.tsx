import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PublicStatusResource } from '@purse/types';

import { StatusReport, headlineOf } from '../src/components/StatusReport';
import { loadEnv } from '../src/env';
import { gatherStatus, ProbeCache, type StatusPageData } from '../src/server/status';

/**
 * The public status page: the render with a failing invariant names it and nothing else,
 * and the server-side gather reads the API's feed and Sideout's `/health` through a
 * cache that serves the last good answer while a probe fails, then reports the service
 * down once that answer is too old.
 */
const T0 = Date.parse('2026-09-19T10:00:00.000Z');

const feed = (overrides: Partial<PublicStatusResource> = {}): PublicStatusResource => ({
  status: 'ok',
  sha: 'abc1234',
  migrations: { applied: 17, available: 17, pending: 0 },
  rulesetVersion: '2026.09.1',
  sdkVersion: '0.4.0',
  invariants: [
    { id: 'I1', name: 'journal nets to zero per asset', status: 'ok' },
    { id: 'I2', name: 'every entry balances', status: 'ok' },
    { id: 'I3', name: 'no user wallet is negative', status: 'ok' },
    { id: 'I4', name: 'settled contests have zero escrow', status: 'ok' },
    { id: 'I5', name: 'settled payouts equal escrowed total', status: 'ok' },
    { id: 'I6', name: 'every snapshot equals its derived balance', status: 'ok' },
    { id: 'I7', name: 'every entry ledger link is a matching escrow entry', status: 'ok' },
  ],
  lastRun: { ok: true, source: 'schedule', ranAt: '2026-09-19T09:45:00.000Z', durationMs: 42, failed: [] },
  runs: [
    { ok: true, source: 'schedule', ranAt: '2026-09-19T09:45:00.000Z', durationMs: 42, failed: [] },
    { ok: true, source: 'console', ranAt: '2026-09-19T09:30:00.000Z', durationMs: 40, failed: [] },
  ],
  generatedAt: '2026-09-19T10:00:00.000Z',
  ...overrides,
});

const page = (overrides: Partial<StatusPageData> = {}): StatusPageData => ({
  feed: feed(),
  feedCheckedAt: '2026-09-19T10:00:00.000Z',
  feedStale: false,
  services: [
    { id: 'purse', label: 'Purse API', state: 'up', note: 'Answering', checkedAt: '2026-09-19T10:00:00.000Z', stale: false },
    { id: 'console', label: 'Operator console', state: 'up', note: 'Rendered this page', checkedAt: '2026-09-19T10:00:00.000Z', stale: false },
    { id: 'sideout', label: 'Sideout', state: 'up', note: 'Answering', checkedAt: '2026-09-19T10:00:00.000Z', stale: false },
  ],
  consoleSha: 'def5678',
  generatedAt: '2026-09-19T10:00:00.000Z',
  ...overrides,
});

describe('StatusReport', () => {
  it('renders every invariant green, the services, the runs and the build, and refreshes itself without script', () => {
    render(<StatusReport data={page()} refreshSeconds={45} />);
    const main = screen.getByTestId('status-page');
    expect(main.dataset['status']).toBe('ok');
    expect(screen.getByTestId('status-headline').textContent).toBe('All invariants hold');
    expect(within(screen.getByTestId('status-invariants')).getAllByRole('listitem')).toHaveLength(7);
    expect(main.querySelectorAll('[data-invariant][data-status="ok"]')).toHaveLength(7);
    expect(main.querySelectorAll('[data-service][data-state="up"]')).toHaveLength(3);
    expect(within(screen.getByTestId('status-runs')).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByTestId('status-build').textContent).toContain('abc1234');
    expect(screen.getByTestId('status-build').textContent).toContain('17 applied, none pending');
    expect(screen.getByTestId('status-build').textContent).toContain('2026.09.1');
    expect(screen.getByTestId('status-build').textContent).toContain('def5678');
    expect(screen.getByText(/Last reconcile 2026-09-19 09:45:00Z by the scheduled job, 42 ms/)).toBeTruthy();
    expect(screen.getByText(/This page is public/)).toBeTruthy();
    // React hoists the meta refresh into the head; a browser with script off reloads on it.
    const refresh = document.head.querySelector('meta[http-equiv="refresh"]') ?? document.querySelector('meta[http-equiv="refresh"]');
    expect(refresh?.getAttribute('content')).toBe('45');
    expect(main.querySelector('script')).toBeNull();
  });

  it('names a failing invariant, turns red, and says nothing more about it', () => {
    const failing = feed({
      status: 'failing',
      invariants: feed().invariants.map((each) => (each.id === 'I3' ? { ...each, status: 'failed' as const } : each)),
      lastRun: { ok: false, source: 'schedule', ranAt: '2026-09-19T10:00:00.000Z', durationMs: 51, failed: ['I3'] },
      runs: [{ ok: false, source: 'schedule', ranAt: '2026-09-19T10:00:00.000Z', durationMs: 51, failed: ['I3'] }, ...feed().runs],
    });
    const { container } = render(<StatusReport data={page({ feed: failing })} />);
    const main = screen.getByTestId('status-page');
    expect(main.dataset['status']).toBe('failing');
    expect(screen.getByTestId('status-headline').textContent).toBe('I3 failing');
    expect(screen.getByTestId('status-headline').className).toContain('so-stat__value--fault');
    const row = main.querySelector('[data-invariant="I3"]');
    expect(row?.className).toContain('invariant--failed');
    expect(row?.getAttribute('data-status')).toBe('failed');
    expect(row?.textContent).toBe('I3no user wallet is negativeFAILING');
    expect(main.querySelectorAll('[data-invariant][data-status="failed"]')).toHaveLength(1);
    expect(main.querySelectorAll('[data-invariant][data-status="ok"]')).toHaveLength(6);
    expect(within(screen.getByTestId('status-runs')).getByText('failing: I3')).toBeTruthy();
    // The services are still up: a failing invariant is not an outage.
    expect(main.querySelectorAll('[data-service][data-state="up"]')).toHaveLength(3);
    // No id, balance, name or detail sentence anywhere on the page.
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/acct_|usr_|tnt_|cnt_|POINTS|CREDIT|detail/);
  });

  it('reports the API down, Sideout down and Sideout unconfigured', () => {
    const down = page({
      feed: null,
      services: [
        { id: 'purse', label: 'Purse API', state: 'down', note: 'Not answering', checkedAt: '2026-09-19T10:00:00.000Z', stale: false },
        { id: 'console', label: 'Operator console', state: 'up', note: 'Rendered this page', checkedAt: '2026-09-19T10:00:00.000Z', stale: false },
        { id: 'sideout', label: 'Sideout', state: 'not_configured', note: 'Not configured on this console', checkedAt: '2026-09-19T10:00:00.000Z', stale: false },
      ],
    });
    render(<StatusReport data={down} />);
    expect(screen.getByTestId('status-page').dataset['status']).toBe('degraded');
    expect(screen.getByTestId('status-headline').textContent).toBe('The Purse API is not answering');
    expect(screen.queryByTestId('status-invariants')).toBeNull();
    expect(screen.queryByTestId('status-runs')).toBeNull();
    expect(screen.getByText('not configured')).toBeTruthy();

    const sideoutDown = page({ services: page().services.map((each) => (each.id === 'sideout' ? { ...each, state: 'down' as const, note: 'Not answering' } : each)) });
    expect(headlineOf(sideoutDown)).toEqual({ tone: 'fault', text: 'Sideout not answering', state: 'degraded' });
    expect(headlineOf(page({ feed: feed({ status: 'unknown', lastRun: null, runs: [], invariants: feed().invariants.map((each) => ({ ...each, status: 'unknown' as const })) }) }))).toMatchObject({ state: 'unknown', text: 'Not checked yet' });
  });
});

describe('gatherStatus', () => {
  type Answer = { status: number; body?: unknown } | Error;
  const answers = (script: Record<string, Answer[]>): { fetch: typeof fetch; calls: string[] } => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const next = script[url]?.shift();
      if (next === undefined) return Promise.reject(new Error(`unscripted ${url}`));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'content-type': 'application/json' } }));
    };
    return { fetch: fetchImpl, calls };
  };

  const deps = (fetchImpl: typeof fetch, clock: () => number, sideoutOrigin?: string) => ({
    env: loadEnv({ PURSE_API_ORIGIN: 'http://purse.test', ...(sideoutOrigin === undefined ? {} : { SIDEOUT_ORIGIN: sideoutOrigin }), BUILD_SHA: 'def5678' }),
    fetch: fetchImpl,
    clock,
    requestId: 'req-1',
    feed: new ProbeCache<PublicStatusResource>(30_000, 120_000),
    sideout: new ProbeCache<{ up: boolean; status: number }>(30_000, 120_000),
  });

  it('reads the feed and Sideout once per TTL, from the server, and marks Sideout not configured when unset', async () => {
    let now = T0;
    const { fetch: fetchImpl, calls } = answers({
      'http://purse.test/v1/status': [{ status: 200, body: { data: feed() } }, { status: 200, body: { data: feed({ generatedAt: '2026-09-19T10:00:30.000Z' }) } }],
    });
    const d = deps(fetchImpl, () => now);
    const first = await gatherStatus(d);
    expect(first.feed?.generatedAt).toBe('2026-09-19T10:00:00.000Z');
    expect(first.services.map((each) => [each.id, each.state])).toEqual([
      ['purse', 'up'],
      ['console', 'up'],
      ['sideout', 'not_configured'],
    ]);
    expect(first.consoleSha).toBe('def5678');
    now += 10_000;
    const again = await gatherStatus(d);
    expect(again.feed?.generatedAt).toBe('2026-09-19T10:00:00.000Z');
    expect(calls).toEqual(['http://purse.test/v1/status']);
    now += 25_000;
    const third = await gatherStatus(d);
    expect(third.feed?.generatedAt).toBe('2026-09-19T10:00:30.000Z');
    expect(calls).toHaveLength(2);
  });

  it('keeps the last good Sideout answer while a probe fails, then reports it down', async () => {
    let now = T0;
    const { fetch: fetchImpl, calls } = answers({
      'http://purse.test/v1/status': [{ status: 200, body: { data: feed() } }, { status: 200, body: { data: feed() } }, { status: 200, body: { data: feed() } }, { status: 200, body: { data: feed() } }],
      'http://sideout.test/health': [{ status: 200, body: { data: {} } }, new Error('ETIMEDOUT'), new Error('ETIMEDOUT'), { status: 503, body: { error: {} } }],
    });
    const d = deps(fetchImpl, () => now, 'http://sideout.test/');
    const up = (await gatherStatus(d)).services.find((each) => each.id === 'sideout');
    expect(up).toMatchObject({ state: 'up', stale: false, checkedAt: '2026-09-19T10:00:00.000Z' });

    // A minute later the probe times out: still up, stale, with the time it was last confirmed.
    now += 60_000;
    const stale = (await gatherStatus(d)).services.find((each) => each.id === 'sideout');
    expect(stale).toMatchObject({ state: 'up', stale: true, checkedAt: '2026-09-19T10:00:00.000Z' });
    expect(stale?.note).toMatch(/latest check did not complete/);
    // ...and that verdict is held for the TTL: no re-probe within it.
    now += 10_000;
    await gatherStatus(d);
    expect(calls.filter((each) => each.startsWith('http://sideout.test'))).toHaveLength(2);

    // Past the stale window the silence is an outage.
    now += 60_000;
    const down = (await gatherStatus(d)).services.find((each) => each.id === 'sideout');
    expect(down).toMatchObject({ state: 'down', stale: false, checkedAt: '2026-09-19T10:02:10.000Z', note: 'Not answering' });

    // Sideout answering 503 is Sideout saying its own database is gone.
    now += 30_000;
    const sick = (await gatherStatus(d)).services.find((each) => each.id === 'sideout');
    expect(sick).toMatchObject({ state: 'down', note: 'Answering, but reporting its own database unreachable' });
  });

  it('reports the API down when the feed cannot be read, keeping the feed while it is recent', async () => {
    let now = T0;
    const { fetch: fetchImpl } = answers({
      'http://purse.test/v1/status': [{ status: 200, body: { data: feed() } }, { status: 503, body: { error: { type: 'internal_error', code: 'database_unavailable' } } }, new Error('ECONNREFUSED')],
    });
    const d = deps(fetchImpl, () => now);
    expect((await gatherStatus(d)).feed).not.toBeNull();
    now += 30_000;
    const stale = await gatherStatus(d);
    expect(stale.feed).not.toBeNull();
    expect(stale.feedStale).toBe(true);
    expect(stale.feedCheckedAt).toBe('2026-09-19T10:00:00.000Z');
    expect(stale.services[0]).toMatchObject({ id: 'purse', state: 'up', stale: true });
    now += 120_000;
    const gone = await gatherStatus(d);
    expect(gone.feed).toBeNull();
    expect(gone.services[0]).toMatchObject({ id: 'purse', state: 'down', checkedAt: '2026-09-19T10:02:30.000Z' });
    expect(headlineOf(gone).state).toBe('degraded');
  });

  it('never sends a cookie or a bearer, and forwards the request id', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response(JSON.stringify({ data: feed() }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    await gatherStatus(deps(fetchImpl, () => T0, 'http://sideout.test'));
    expect(seen).toHaveLength(2);
    for (const init of seen) {
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('x-request-id')).toBe('req-1');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
