import { NextResponse } from 'next/server';
import { z } from 'zod';
import { REQUEST_ID_HEADER, type ApiError, type ConsoleSessionResource } from '@purse/types';

import { env } from '../../../../env';
import { logger } from '../../../../lib/logger';
import { SESSION_COOKIE, sessionCookieOptions } from '../../../../server/session';

/**
 * `POST /api/auth/login`: the sign-in form posts here (JSON, same origin); the console
 * signs in against the Purse API and keeps the session token in the HttpOnly cookie.
 * The token is never returned to the browser. The API rate limits failed sign-ins by
 * address; the client's address is forwarded so it is the browser's, not this server's.
 */
const bodySchema = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(512) }).strict();

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => undefined);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: { type: 'invalid_request', code: 'validation_failed', message: 'Email and password are required' } satisfies ApiError }, { status: 400 });
  const headers = new Headers({ 'content-type': 'application/json', Accept: 'application/json' });
  const requestId = request.headers.get(REQUEST_ID_HEADER);
  if (requestId !== null) headers.set(REQUEST_ID_HEADER, requestId);
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) headers.set('x-forwarded-for', forwarded);
  let res: Response;
  try {
    res = await fetch(`${env().apiOrigin}/console/auth/login`, { method: 'POST', headers, body: JSON.stringify(parsed.data), cache: 'no-store' });
  } catch (error) {
    logger().error('purse api unreachable at sign-in', { reason: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: { type: 'internal_error', code: 'api_unreachable', message: 'The Purse API is unreachable' } satisfies ApiError }, { status: 503 });
  }
  const envelope = (await res.json().catch(() => ({}))) as { data?: ConsoleSessionResource; error?: ApiError };
  if (!res.ok || envelope.data === undefined) {
    const error = envelope.error ?? { type: 'internal_error', code: 'malformed_response', message: 'Sign-in failed' };
    const response = NextResponse.json({ error }, { status: res.status });
    const retryAfter = res.headers.get('Retry-After');
    if (retryAfter !== null) response.headers.set('Retry-After', retryAfter);
    return response;
  }
  const { token, ...rest } = envelope.data;
  const response = NextResponse.json({ data: { operator: rest.operator, expiresAt: rest.expiresAt } });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(new Date(rest.expiresAt)));
  logger().info('operator signed in', { operatorId: rest.operator.id, sessionId: rest.sessionId });
  return response;
}
