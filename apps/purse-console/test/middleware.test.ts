import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../src/lib/session-cookie';
import { OPEN_PATHS, middleware } from '../src/middleware';

/**
 * The session gate opens exactly four paths to a request with no cookie: sign-in, its
 * form action, `/health`, and the public `/status` page. Every other page, including
 * anything under `/status/`, is sent to sign in.
 */
const request = (path: string, cookie?: string): NextRequest => new NextRequest(`http://console.test${path}`, cookie === undefined ? {} : { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

describe('console middleware', () => {
  it('opens exactly the sign-in paths, /health and /status', () => {
    expect(OPEN_PATHS).toEqual(['/login', '/api/auth/login', '/health', '/status']);
  });

  it('lets a stranger read /status and nothing else that renders', () => {
    for (const path of ['/status', '/health', '/login']) {
      const response = middleware(request(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get('location'), path).toBeNull();
    }
    for (const path of ['/', '/status/anything', '/statuses', '/invariants', '/tenants/tnt_1/ledger?asOf=now', '/contests?state=settled']) {
      const response = middleware(request(path));
      expect(response.status, path).toBe(307);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.pathname, path).toBe('/login');
      expect(location.searchParams.get('next'), path).toBe(path === '/' ? null : path);
    }
  });

  it('lets a request with a cookie through to the page, which then verifies it', () => {
    const response = middleware(request('/invariants', 'cst_anything'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/\S/);
  });

  it('never gates API routes here', () => {
    expect(middleware(request('/api/purse/reconcile')).status).toBe(200);
  });
});
