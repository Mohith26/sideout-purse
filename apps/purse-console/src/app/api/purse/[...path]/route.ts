import { NextResponse, type NextRequest } from 'next/server';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, REQUEST_ID_HEADER, RETRY_AFTER_HEADER, type ApiError } from '@purse/types';

import { env } from '../../../../env';
import { logger } from '../../../../lib/logger';
import { readSessionToken } from '../../../../server/session';

/**
 * `/api/purse/*`: the one path from the browser to the Purse API. A client component
 * calls `/api/purse/tenants/.../close` on this origin; this handler forwards it to
 * `PURSE_API_ORIGIN/console/tenants/.../close` with the operator's session token from the
 * HttpOnly cookie as the bearer, the `Idempotency-Key` and the request id, and returns
 * the API's envelope and status unchanged. The token never reaches the browser, and no
 * key of any kind exists in this app. A mutation must be `application/json` (a cross-site
 * form cannot send that, so with `SameSite=Lax` this is the CSRF guard), and only the
 * console routes are reachable: the path is appended under `/console`, never anything else.
 */
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const token = await readSessionToken();
  if (token === undefined) return NextResponse.json({ error: { type: 'authentication_error', code: 'missing_session', message: 'Sign in to continue' } satisfies ApiError }, { status: 401 });
  const { path } = await context.params;
  if (path.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return NextResponse.json({ error: { type: 'invalid_request', code: 'not_found', message: 'No such console route' } satisfies ApiError }, { status: 404 });
  }
  const method = request.method.toUpperCase();
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
  const requestId = request.headers.get(REQUEST_ID_HEADER);
  if (requestId !== null) headers.set(REQUEST_ID_HEADER, requestId);
  let body: string | undefined;
  if (MUTATING.has(method)) {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return NextResponse.json({ error: { type: 'invalid_request', code: 'unsupported_media_type', message: 'Console mutations must be application/json' } satisfies ApiError }, { status: 415 });
    }
    body = await request.text();
    headers.set('content-type', 'application/json');
    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey !== null) headers.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  }
  const target = `${env().apiOrigin}/console/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, ...(body === undefined ? {} : { body }), cache: 'no-store' });
  } catch (error) {
    logger().error('purse api unreachable', { method, path: path.join('/'), reason: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: { type: 'internal_error', code: 'api_unreachable', message: 'The Purse API is unreachable' } satisfies ApiError }, { status: 503 });
  }
  const text = await upstream.text();
  const response = new NextResponse(text, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  for (const name of [IDEMPOTENT_REPLAYED_HEADER, RETRY_AFTER_HEADER]) {
    const value = upstream.headers.get(name);
    if (value !== null) response.headers.set(name, value);
  }
  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
