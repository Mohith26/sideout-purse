import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * The app session (decision D8: Sideout owns its own session). A signed, HttpOnly,
 * SameSite=Lax cookie carrying the user id and an expiry; the signature is an HMAC-SHA256
 * over the payload with a key derived from `SESSION_SECRET`. Nothing is stored server
 * side, so a session cannot be enumerated and a secret rotation signs everyone out. A
 * session opened through the public demo's account picker carries `via: 'demo'`
 * (`docs/demo-accounts.md`), which the shell reads to mark every screen of it; a phone
 * sign-in carries no `via` at all.
 */

export const SESSION_COOKIE = 'sideout_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const SESSION_VIAS = ['demo'] as const;
/** How a session was opened, when it was not a phone sign-in. */
export type SessionVia = (typeof SESSION_VIAS)[number];

const payloadSchema = z.object({
  v: z.literal(1),
  uid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  via: z.enum(SESSION_VIAS).optional(),
});

export type SessionPayload = z.infer<typeof payloadSchema>;

/** What a verified token vouches for: the user, and how the session was opened (`null` for a phone sign-in). */
export type VerifiedSession = { userId: string; via: SessionVia | null };

function sessionKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('sideout:session:v1').digest();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', sessionKey(secret)).update(payload).digest('base64url');
}

export function issueSession(userId: string, secret: string, now: Date, options: { via?: SessionVia } = {}): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload: SessionPayload = { v: 1, uid: userId, iat, exp, ...(options.via === undefined ? {} : { via: options.via }) };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(encoded, secret)}`, expiresAt: new Date(exp * 1000) };
}

/** The user id a token vouches for (and how it was opened), or null for anything malformed, forged or expired. */
export function verifySession(token: string, secret: string, now: Date): VerifiedSession | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, secret);
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
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
  return { userId: payload.data.uid, via: payload.data.via ?? null };
}

export function sessionCookieHeader(token: string, options: { secure: boolean; maxAgeSeconds?: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds ?? SESSION_TTL_SECONDS}`,
  ];
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
