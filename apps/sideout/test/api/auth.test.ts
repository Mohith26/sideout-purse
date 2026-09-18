import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as logout } from '../../src/app/api/auth/logout/route';
import { POST as requestCode } from '../../src/app/api/auth/request-code/route';
import { POST as verify } from '../../src/app/api/auth/verify/route';
import { GET as me } from '../../src/app/api/me/route';
import { auditLog, authCodes, users } from '../../src/db/schema';
import { env } from '../../src/env';
import { CODE_MAX_ATTEMPTS } from '../../src/server/auth/codes';
import { issueSession, sessionCookieHeader } from '../../src/server/auth/session';
import { unavailableSmsSender, type SmsSender } from '../../src/server/auth/sms';
import { AUTH_RATE_LIMITS, resetAppContext } from '../../src/server/context';
import { cookieFor, createUser, data, errorOf, nextPhone, request, testDatabase, truncateAll, type Database } from '../helpers';

type CodeResponse = { expiresAt: string; code?: string };
type VerifyResponse = { user: { id: string; displayName: string; displayNameIsDefault: boolean; phoneE164: string | null; role: string }; created: boolean };

describe('phone sign-in', () => {
  let database: Database;
  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
  });
  afterAll(async () => {
    await database.close();
  });

  it('issues a code (echoed outside production), verifies it, creates the account and sets the session cookie', async () => {
    const phone = nextPhone();
    const issued = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone } })));
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const [stored] = await database.db.select().from(authCodes).where(eq(authCodes.phoneE164, phone));
    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.codeHash).not.toContain(issued.code ?? 'never');

    const response = await verify(request('POST', '/api/auth/verify', { body: { phone, code: issued.code, displayName: 'Maya Delgado' } }));
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^sideout_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect(cookie).not.toContain('Secure'); // test is not production
    const body = await data<VerifyResponse>(response);
    expect(body.created).toBe(true);
    expect(body.user).toMatchObject({ displayName: 'Maya Delgado', displayNameIsDefault: false, phoneE164: phone, role: 'player' });
    expect(body.user).not.toHaveProperty('purseExternalId');

    const [row] = await database.db.select().from(users).where(eq(users.phoneE164, phone));
    expect(row?.purseExternalId).toMatch(/^sideout-user-[0-9a-f]{32}$/);
    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, row?.id ?? ''));
    expect(trail.map((a) => a.action)).toEqual(['user.created']);

    const meResponse = await me(request('GET', '/api/me', { cookie: cookie.split(';')[0] }));
    expect(meResponse.status).toBe(200);
    const snapshot = await data<{ user: { id: string } }>(meResponse);
    expect(snapshot.user.id).toBe(row?.id);
  });

  it('a second sign-in finds the same account; a default display name comes from the opaque id, never the number', async () => {
    const phone = nextPhone();
    const first = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone } })));
    const created = await data<VerifyResponse>(await verify(request('POST', '/api/auth/verify', { body: { phone, code: first.code } })));
    expect(created.user.displayName).toBe(`Player ${created.user.id.slice(-4)}`);
    expect(created.user.displayName).not.toContain(phone.slice(-4));
    expect(created.user.displayNameIsDefault).toBe(true);
    const second = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone } })));
    const again = await data<VerifyResponse>(await verify(request('POST', '/api/auth/verify', { body: { phone, code: second.code } })));
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(created.user.id);
  });

  it('rejects a wrong code, locks after too many guesses, and rejects an expired code', async () => {
    const phone = nextPhone();
    const issued = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone } })));
    const wrong = issued.code === '000000' ? '111111' : '000000';

    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) {
      const response = await verify(request('POST', '/api/auth/verify', { body: { phone, code: wrong } }));
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe('code_invalid');
    }
    const locked = await verify(request('POST', '/api/auth/verify', { body: { phone, code: issued.code } }));
    expect((await errorOf(locked)).code).toBe('code_locked');

    await database.db.update(authCodes).set({ expiresAt: new Date(Date.now() - 1000), attempts: 0 }).where(eq(authCodes.phoneE164, phone));
    const expired = await verify(request('POST', '/api/auth/verify', { body: { phone, code: issued.code } }));
    expect((await errorOf(expired)).code).toBe('code_expired');

    const unknown = await verify(request('POST', '/api/auth/verify', { body: { phone: nextPhone(), code: '123456' } }));
    expect((await errorOf(unknown)).code).toBe('code_invalid');
  });

  it("a stranger's requests for the same number neither invalidate the owner's code nor widen the guess budget", async () => {
    const phone = nextPhone();
    const owner = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone } })));
    const stranger = { 'x-forwarded-for': '198.51.100.9' };
    const second = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone }, headers: stranger })));
    const third = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone }, headers: stranger })));
    expect(new Set([owner.code, second.code, third.code]).size).toBeGreaterThan(1);
    // Five wrong guesses are five for the number, whichever code they are aimed at.
    const wrong = (code: string | undefined) => (code === '000000' ? '111111' : '000000');
    for (let i = 0; i < CODE_MAX_ATTEMPTS - 1; i += 1) {
      expect((await errorOf(await verify(request('POST', '/api/auth/verify', { body: { phone, code: wrong(owner.code) } })))).code).toBe('code_invalid');
    }
    // The owner's original code still signs in, and that consumes every code out for the number.
    const signedIn = await verify(request('POST', '/api/auth/verify', { body: { phone, code: owner.code } }));
    expect(signedIn.status).toBe(200);
    const outstanding = await database.db.select().from(authCodes).where(eq(authCodes.phoneE164, phone));
    expect(outstanding).toHaveLength(3);
    expect(outstanding.every((row) => row.consumedAt !== null)).toBe(true);
    expect((await errorOf(await verify(request('POST', '/api/auth/verify', { body: { phone, code: third.code } })))).code).toBe('code_invalid');
    // The stranger did spend the number's window, which is the cost that remains.
    const fourth = await requestCode(request('POST', '/api/auth/request-code', { body: { phone } }));
    expect(fourth.status).toBe(429);
    expect((await errorOf(fourth)).detail).toMatchObject({ scope: 'phone' });
  });

  it('caps the codes one instance sends by the configured SMS budget', async () => {
    resetAppContext({ env: { ...env(), authCodeGlobalCap: 2 } });
    expect((await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() } }))).status).toBe(200);
    expect((await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() } }))).status).toBe(200);
    const capped = await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() } }));
    expect(capped.status).toBe(429);
    expect((await errorOf(capped)).detail).toMatchObject({ scope: 'global', retryAfterSeconds: expect.any(Number) as number });
  });

  it('validates the phone number and the body shape with the error envelope', async () => {
    const bad = await requestCode(request('POST', '/api/auth/request-code', { body: { phone: '555-0100' } }));
    expect(bad.status).toBe(400);
    const error = await errorOf(bad);
    expect(error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });
    expect(error.detail).toBeDefined();

    const malformed = await requestCode(request('POST', '/api/auth/request-code', { body: '{not json' }));
    expect((await errorOf(malformed)).code).toBe('malformed_json');

    // Formatting noise is stripped before validation.
    const spaced = await requestCode(request('POST', '/api/auth/request-code', { body: { phone: '+1 (415) 555-0299' } }));
    expect(spaced.status).toBe(200);
  });

  it('rate-limits per phone and per address, with a retry hint', async () => {
    const phone = nextPhone();
    for (let i = 0; i < AUTH_RATE_LIMITS.perPhone.limit; i += 1) {
      expect((await requestCode(request('POST', '/api/auth/request-code', { body: { phone } }))).status).toBe(200);
    }
    const limited = await requestCode(request('POST', '/api/auth/request-code', { body: { phone } }));
    expect(limited.status).toBe(429);
    const error = await errorOf(limited);
    expect(error).toMatchObject({ type: 'rate_limited', code: 'too_many_requests' });
    expect(error.detail).toMatchObject({ scope: 'phone', retryAfterSeconds: expect.any(Number) as number });

    // Per address: a different phone from the same address after the address limit is hit.
    resetAppContext();
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < AUTH_RATE_LIMITS.perAddress.limit; i += 1) {
      expect((await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() }, headers }))).status).toBe(200);
    }
    const address = await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() }, headers }));
    expect((await errorOf(address)).detail).toMatchObject({ scope: 'address' });
    // ...while another address is unaffected.
    const other = await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() }, headers: { 'x-forwarded-for': '203.0.113.8' } }));
    expect(other.status).toBe(200);
  });

  it('refuses with sms_unavailable and issues nothing when no SMS provider is configured', async () => {
    resetAppContext({ sms: unavailableSmsSender });
    const phone = nextPhone();
    const response = await requestCode(request('POST', '/api/auth/request-code', { body: { phone } }));
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ type: 'internal_error', code: 'sms_unavailable' });
    expect(await database.db.select().from(authCodes).where(eq(authCodes.phoneE164, phone))).toHaveLength(0);
  });

  it('consumes a code the provider could not deliver, so it can never be verified', async () => {
    const delivered: string[] = [];
    const flaky: SmsSender = {
      name: 'log',
      send: async ({ body }) => {
        await Promise.resolve();
        if (delivered.length === 0) {
          delivered.push('failed');
          throw new Error('provider timeout');
        }
        delivered.push(body);
      },
    };
    resetAppContext({ sms: flaky });
    const phone = nextPhone();
    const failed = await requestCode(request('POST', '/api/auth/request-code', { body: { phone } }));
    expect(failed.status).toBe(500);
    const [row] = await database.db.select().from(authCodes).where(eq(authCodes.phoneE164, phone));
    expect(row?.consumedAt).not.toBeNull();

    const issued = await data<CodeResponse>(await requestCode(request('POST', '/api/auth/request-code', { body: { phone } })));
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain(issued.code ?? 'never');
    const verified = await verify(request('POST', '/api/auth/verify', { body: { phone, code: issued.code } }));
    expect(verified.status).toBe(200);
  });

  it('rejects a missing, forged or expired session on a protected route', async () => {
    expect((await me(request('GET', '/api/me'))).status).toBe(401);
    expect((await errorOf(await me(request('GET', '/api/me')))).code).toBe('sign_in_required');

    const user = await createUser(database);
    const forged = issueSession(user.id, 'not-the-real-secret-not-the-real-secret', new Date());
    const forgedCookie = sessionCookieHeader(forged.token, { secure: false }).split(';')[0];
    expect((await me(request('GET', '/api/me', { cookie: forgedCookie }))).status).toBe(401);

    const expiredCookie = cookieFor(user, new Date(Date.now() - 40 * 24 * 3600 * 1000));
    expect((await me(request('GET', '/api/me', { cookie: expiredCookie }))).status).toBe(401);

    const tampered = `${cookieFor(user).slice(0, -3)}abc`;
    expect((await me(request('GET', '/api/me', { cookie: tampered }))).status).toBe(401);

    expect((await me(request('GET', '/api/me', { cookie: cookieFor(user) }))).status).toBe(200);
  });

  it('logout clears the cookie', async () => {
    const response = await logout(request('POST', '/api/auth/logout'));
    expect(response.headers.get('set-cookie')).toMatch(/^sideout_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
    expect(env().nodeEnv).toBe('test');
  });
});
