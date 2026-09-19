import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_ID_HEADER } from '@purse/types';

import { GET, type ConsoleHealthReport } from '../src/app/health/route';

/**
 * The console's `/health` is the process's own answer: its sha, plus whether the Purse
 * API answered. The API being down or failing is reported in the body, never as a 503.
 */
describe('GET /health', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (status: number): typeof fetch => () => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status, headers: { 'content-type': 'application/json' } }));

  it('reports the sha and the API as ok, failing or unreachable, always with 200', async () => {
    vi.stubGlobal('fetch', answer(200));
    const ok = await GET(new Request('http://console.test/health', { headers: { [REQUEST_ID_HEADER]: 'probe-0001' } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get(REQUEST_ID_HEADER)).toBe('probe-0001');
    const body = (await ok.json()) as { data: ConsoleHealthReport };
    expect(body.data.api).toBe('ok');
    expect(body.data.sha.length).toBeGreaterThan(0);
    expect(Object.keys(body.data).sort()).toEqual(['api', 'sha']);

    vi.stubGlobal('fetch', answer(503));
    expect(((await (await GET(new Request('http://console.test/health'))).json()) as { data: ConsoleHealthReport }).data.api).toBe('failing');

    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const down = await GET(new Request('http://console.test/health'));
    expect(down.status).toBe(200);
    expect(((await down.json()) as { data: ConsoleHealthReport }).data.api).toBe('unreachable');
  });

  it('never includes the API origin', async () => {
    vi.stubGlobal('fetch', answer(200));
    const text = await (await GET(new Request('http://console.test/health'))).text();
    expect(text).not.toContain('localhost');
    expect(text).not.toContain('http');
  });
});
