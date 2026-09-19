import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * The app session (decision D8: a tenant owns its own session). A signed, HttpOnly,
 * SameSite=Lax cookie carrying the player id and an expiry; the signature is an
 * HMAC-SHA256 over the payload with a key derived from `SESSION_SECRET`. Nothing is stored
 * server side, so a secret rotation signs everyone out.
 */

export const SESSION_COOKIE = 'pingpong_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const payloadSchema = z.object({
  v: z.literal(1),
  pid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});

function sessionKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('pingpong:session:v1').digest();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', sessionKey(secret)).update(payload).digest('base64url');
}

export function issueSession(playerId: string, secret: string, now: Date): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const encoded = Buffer.from(JSON.stringify({ v: 1, pid: playerId, iat, exp }), 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(encoded, secret)}`, expiresAt: new Date(exp * 1000) };
}

/** The player id a token vouches for, or null for anything malformed, forged or expired. */
export function verifySession(token: string, secret: string, now: Date): { playerId: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const wanted = Buffer.from(sign(encoded, secret), 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const payload = payloadSchema.safeParse(parsed);
  if (!payload.success) return null;
  if (payload.data.exp * 1000 <= now.getTime()) return null;
  return { playerId: payload.data.pid };
}

export function sessionCookieHeader(token: string, options: { secure: boolean; maxAgeSeconds?: number }): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${options.maxAgeSeconds ?? SESSION_TTL_SECONDS}`];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(options: { secure: boolean }): string {
  return sessionCookieHeader('', { secure: options.secure, maxAgeSeconds: 0 });
}

/** The session token from a `Cookie` header, if present. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}
