import { NextResponse } from 'next/server';

import { consoleFetch } from '../../../../server/api';
import { SESSION_COOKIE, readSessionToken, sessionCookieOptions } from '../../../../server/session';

/** `POST /api/auth/logout`: revoke the session at the API and clear the cookie, whatever the API said. */
export async function POST(): Promise<Response> {
  const token = await readSessionToken();
  if (token !== undefined) await consoleFetch('/auth/logout', { method: 'POST', body: {}, token });
  const response = NextResponse.json({ data: { signedOut: true } });
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
  return response;
}
