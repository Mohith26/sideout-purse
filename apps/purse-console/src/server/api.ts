import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { REQUEST_ID_HEADER, type ApiError } from '@purse/types';

import { env } from '../env';
import { logger } from '../lib/logger';
import { CONSOLE_PATH_HEADER } from '../lib/session-cookie';
import { readSessionToken } from './session';

/**
 * Server-side reads against the Purse API's `/console` routes. Every page fetches through
 * here: the operator's session token from the cookie becomes the bearer, the request id
 * is forwarded, nothing is cached, and a 401 (no session, expired, revoked) sends the
 * operator to the sign-in page with the path to come back to. Any other refusal is
 * returned as the API's sealed error so the page can render it in place.
 */
export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; error: ApiError; status: number };

export async function consoleFetch<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string; token?: string } = {}): Promise<ApiResult<T>> {
  const token = init.token ?? (await readSessionToken());
  if (token === undefined) return { ok: false, status: 401, error: { type: 'authentication_error', code: 'missing_session', message: 'Sign in to continue' } };
  const requestHeaders = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
  const incoming = await headers();
  const requestId = incoming.get(REQUEST_ID_HEADER);
  if (requestId !== null) requestHeaders.set(REQUEST_ID_HEADER, requestId);
  if (init.body !== undefined) requestHeaders.set('content-type', 'application/json');
  if (init.idempotencyKey !== undefined) requestHeaders.set('Idempotency-Key', init.idempotencyKey);
  let res: Response;
  try {
    res = await fetch(`${env().apiOrigin}/console${path}`, {
      method: init.method ?? 'GET',
      headers: requestHeaders,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
    });
  } catch (error) {
    logger().error('purse api unreachable', { path, reason: error instanceof Error ? error.message : String(error) });
    return { ok: false, status: 503, error: { type: 'internal_error', code: 'api_unreachable', message: 'The Purse API is unreachable' } };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = {};
  }
  const envelope = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { data?: T; error?: ApiError };
  if (res.ok && envelope.data !== undefined) return { ok: true, data: envelope.data, status: res.status };
  const error = envelope.error ?? { type: 'internal_error', code: 'malformed_response', message: `The Purse API answered ${res.status} without an envelope` };
  return { ok: false, status: res.status, error };
}

/** Where sign-in sends the operator back to: the page being rendered (from the middleware's header), or the caller's say. */
async function signInPath(returnTo: string | undefined): Promise<string> {
  const current = returnTo ?? (await headers()).get(CONSOLE_PATH_HEADER) ?? undefined;
  return `/login${current === undefined || current === '/' ? '' : `?next=${encodeURIComponent(current)}`}`;
}

/**
 * A page's read: the data, or a redirect to sign-in on 401, the not-found page on 404 (and
 * on the API's `*_not_found` refusals, which it answers 400 for a well-formed id that names
 * nothing), or a thrown `ConsoleApiError` the page's error boundary renders.
 */
export async function load<T>(path: string, returnTo?: string): Promise<T> {
  const result = await consoleFetch<T>(path);
  if (result.ok) return result.data;
  if (result.status === 401) redirect(await signInPath(returnTo));
  if (result.status === 404 || (result.status === 400 && result.error.code.endsWith('_not_found'))) notFound();
  throw new ConsoleApiError(result.error, result.status);
}

/** As `load`, but a refusal is returned rather than thrown, for a page that renders it inline. */
export async function loadResult<T>(path: string, returnTo?: string): Promise<ApiResult<T>> {
  const result = await consoleFetch<T>(path);
  if (!result.ok && result.status === 401) redirect(await signInPath(returnTo));
  return result;
}

export class ConsoleApiError extends Error {
  override readonly name = 'ConsoleApiError';
  constructor(
    readonly error: ApiError,
    readonly status: number,
  ) {
    super(`${error.type}/${error.code}: ${error.message}`);
  }
}
