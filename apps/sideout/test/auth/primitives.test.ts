import { describe, expect, it } from 'vitest';

import { clientAddress } from '../../src/server/auth/client-address';
import { CODE_LENGTH, codeMatches, generateCode, hashCode } from '../../src/server/auth/codes';
import { phoneE164Schema } from '../../src/server/auth/phone';
import { createRateLimiter } from '../../src/server/auth/rate-limit';
import { clearSessionCookieHeader, issueSession, readSessionCookie, SESSION_TTL_SECONDS, sessionCookieHeader, verifySession } from '../../src/server/auth/session';

describe('session tokens', () => {
  const secret = 'a-session-secret-that-is-long-enough-for-tests';
  const now = new Date('2026-09-18T12:00:00Z');

  it('round-trips a user id and expires after the ttl', () => {
    const { token, expiresAt } = issueSession('sou_1', secret, now);
    expect(expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_SECONDS * 1000);
    expect(verifySession(token, secret, now)).toEqual({ userId: 'sou_1' });
    expect(verifySession(token, secret, new Date(expiresAt.getTime() - 1))).toEqual({ userId: 'sou_1' });
    expect(verifySession(token, secret, expiresAt)).toBeNull();
  });

  it('rejects the wrong secret, a tampered payload, and garbage', () => {
    const { token } = issueSession('sou_1', secret, now);
    expect(verifySession(token, 'another-secret-that-is-also-long-enough', now)).toBeNull();
    const [payload, signature] = token.split('.') as [string, string];
    const other = Buffer.from(JSON.stringify({ v: 1, uid: 'sou_2', iat: 0, exp: 4102444800 })).toString('base64url');
    expect(verifySession(`${other}.${signature}`, secret, now)).toBeNull();
    expect(verifySession(`${payload}.${signature.slice(0, -1)}x`, secret, now)).toBeNull();
    expect(verifySession('', secret, now)).toBeNull();
    expect(verifySession('nodot', secret, now)).toBeNull();
    expect(verifySession('.x', secret, now)).toBeNull();
  });

  it('renders and reads the cookie with the required attributes', () => {
    const header = sessionCookieHeader('tok', { secure: true });
    expect(header).toBe(`sideout_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Secure`);
    expect(sessionCookieHeader('tok', { secure: false })).not.toContain('Secure');
    expect(clearSessionCookieHeader({ secure: false })).toContain('Max-Age=0');
    expect(readSessionCookie('theme=dark; sideout_session=abc.def; other=1')).toBe('abc.def');
    expect(readSessionCookie('theme=dark')).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});

describe('one-time codes', () => {
  const secret = 'a-session-secret-that-is-long-enough-for-tests';

  it('generates zero-padded six-digit codes from the injected randomness', () => {
    expect(generateCode(() => 7)).toBe('000007');
    expect(generateCode(() => 999_999)).toBe('999999');
    expect(generateCode()).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
  });

  it('hashes are bound to the phone and compare in constant time', () => {
    const hash = hashCode('123456', '+14155550101', secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeMatches(hash, '123456', '+14155550101', secret)).toBe(true);
    expect(codeMatches(hash, '123457', '+14155550101', secret)).toBe(false);
    expect(codeMatches(hash, '123456', '+14155550102', secret)).toBe(false);
    expect(codeMatches(hash, '123456', '+14155550101', 'other-secret-that-is-long-enough-too')).toBe(false);
    expect(codeMatches('nothex', '123456', '+14155550101', secret)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('allows `limit` hits per window, then refuses with a retry hint, then recovers', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 10_000, maxKeys: 10 });
    const t0 = new Date('2026-09-18T12:00:00Z');
    expect(limiter.hit('k', t0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.hit('k', new Date(t0.getTime() + 1000))).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.hit('k', new Date(t0.getTime() + 2000))).toEqual({ allowed: false, retryAfterSeconds: 8 });
    expect(limiter.hit('other', new Date(t0.getTime() + 2000)).allowed).toBe(true);
    expect(limiter.hit('k', new Date(t0.getTime() + 10_001)).allowed).toBe(true);
  });

  it('can be asked without being charged', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 10_000, maxKeys: 10 });
    const t0 = new Date('2026-09-18T12:00:00Z');
    expect(limiter.check('k', t0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check('k', t0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.size()).toBe(0);
    expect(limiter.hit('k', t0).allowed).toBe(true);
    expect(limiter.check('k', new Date(t0.getTime() + 4000))).toEqual({ allowed: false, retryAfterSeconds: 6 });
    expect(limiter.check('k', new Date(t0.getTime() + 10_001)).allowed).toBe(true);
  });

  it('is bounded: never holds more than maxKeys keys, evicting the least recently touched', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    const now = new Date();
    for (let i = 0; i < 100; i += 1) limiter.hit(`key-${i}`, now);
    expect(limiter.size()).toBeLessThanOrEqual(3);
    // The evicted keys are the oldest; the newest are still limited.
    expect(limiter.hit('key-99', now).allowed).toBe(false);
    expect(limiter.hit('key-0', now).allowed).toBe(true);
  });
});

describe('client address', () => {
  const headers = (xff?: string) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff });

  it('takes the last entry with no proxy (what Next sets from the socket) and counts back through trusted hops', () => {
    expect(clientAddress(headers(), 0)).toBe('unknown');
    expect(clientAddress(headers('203.0.113.7'), 0)).toBe('203.0.113.7');
    expect(clientAddress(headers('198.51.100.1, 203.0.113.7'), 0)).toBe('203.0.113.7');
    expect(clientAddress(headers('198.51.100.1, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(headers('198.51.100.1, 203.0.113.7, 10.0.0.2'), 2)).toBe('203.0.113.7');
    expect(clientAddress(headers('198.51.100.1'), 5)).toBe('198.51.100.1');
    expect(clientAddress(headers(' , '), 0)).toBe('unknown');
  });
});

describe('phone numbers', () => {
  it('normalises formatting noise and refuses anything but E.164', () => {
    expect(phoneE164Schema.parse('+1 (415) 555-0101')).toBe('+14155550101');
    expect(phoneE164Schema.parse('+44 20 7946 0958')).toBe('+442079460958');
    expect(phoneE164Schema.safeParse('4155550101').success).toBe(false);
    expect(phoneE164Schema.safeParse('+0123').success).toBe(false);
    expect(phoneE164Schema.safeParse('+1234567890123456').success).toBe(false);
  });
});
