import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Id } from '@repo/ids';

import type { ProcessKeys } from '../secrets';

/**
 * The Purse identity session (spec 4.8 rule 1): a signed, HttpOnly cookie on the Purse
 * origin carrying the tenant, the user and an expiry, HMAC-SHA256 under the process's
 * `embed-session` key. `SameSite=None; Secure; Partitioned` because the frame that sets
 * and reads it is embedded in the partner's page: `None` so it is sent from that
 * cross-site context at all, `Secure` because `None` requires it (and Chrome accepts a
 * Secure cookie on `localhost` over plain HTTP, which is the local-dev exception
 * docs/decisions.md records), `Partitioned` (CHIPS) so the browser keys it by the
 * embedding site and third-party cookie blocking does not discard it. Nothing is stored
 * server side; rotating `PURSE_SECRET_KEY` signs everyone out.
 */
export const SESSION_COOKIE = 'purse_session';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

const payloadSchema = z.object({ v: z.literal(1), tid: z.string().min(1), uid: z.string().min(1), iat: z.number().int(), exp: z.number().int() }).strict();

export type SessionPayload = z.infer<typeof payloadSchema>;

export type Session = { tenantId: Id<'tnt'>; userId: Id<'usr'>; expiresAt: Date };

function sign(encoded: string, key: Buffer): string {
  return createHmac('sha256', key).update(encoded).digest('base64url');
}

export function issueSession(keys: ProcessKeys, input: { tenantId: Id<'tnt'>; userId: string; now: Date }): { token: string; expiresAt: Date } {
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload: SessionPayload = { v: 1, tid: input.tenantId, uid: input.userId, iat, exp };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(encoded, keys['embed-session'])}`, expiresAt: new Date(exp * 1000) };
}

/** The session a token vouches for, or undefined for anything malformed, forged, expired or from another tenant. */
export function verifySession(keys: ProcessKeys, token: string | undefined, tenantId: Id<'tnt'>, now: Date): Session | undefined {
  if (token === undefined) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.length > 2048) return undefined;
  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const wanted = Buffer.from(sign(encoded, keys['embed-session']), 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const payload = payloadSchema.safeParse(parsed);
  if (!payload.success) return undefined;
  if (payload.data.exp * 1000 <= now.getTime()) return undefined;
  if (payload.data.tid !== tenantId) return undefined;
  return { tenantId, userId: payload.data.uid as Id<'usr'>, expiresAt: new Date(payload.data.exp * 1000) };
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, { path: '/', httpOnly: true, secure: true, sameSite: 'None', partitioned: true, expires: expiresAt });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'None', partitioned: true });
}
