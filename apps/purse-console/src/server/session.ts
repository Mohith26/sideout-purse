import { cookies } from 'next/headers';

import { env } from '../env';
import { SESSION_COOKIE } from '../lib/session-cookie';

/**
 * The console's session cookie: the operator session token the Purse API issued at
 * sign-in, kept HttpOnly on this origin and sent to the API as a bearer on every call.
 * `SameSite=Lax` keeps a cross-site page from riding the session on a top-level POST,
 * and the proxy (`app/api/purse`) further requires a JSON content type on every
 * mutation, which a cross-site form cannot send.
 */
export { SESSION_COOKIE };
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}

export function sessionCookieOptions(expiresAt: Date) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: env().secureCookies, path: '/', expires: expiresAt };
}
