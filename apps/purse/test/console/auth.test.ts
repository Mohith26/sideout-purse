import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ConsoleMeResource } from '@purse/types';

import { auditLog, operatorSessions } from '../../src/db/schema';
import { LAST_SEEN_WRITE_INTERVAL_MS, SESSION_TTL_MS } from '../../src/operators';
import { SIGN_IN_LIMIT } from '../../src/routes/console/auth';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { client } from '../http/client';
import { wipeLedger } from '../ledger/fixtures';
import { consoleClient, login, makeOperator } from './client';

/**
 * The console's own authentication (spec 4.10): sign-in with an email and a password,
 * a stateful bearer session, sign-out that revokes it, expiry, a password change that
 * signs the other sessions out, the admin role, and the address limit on failed sign-ins.
 */
describe('console auth', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;
  let now = Date.parse('2026-09-18T12:00:00Z');

  beforeAll(() => {
    owner = connectMigrator();
    h = harness({ clock: () => now });
  });
  beforeEach(async () => {
    now = Date.parse('2026-09-18T12:00:00Z');
    await wipeLedger(owner);
  });
  afterAll(async () => {
    await wipeLedger(owner);
    await h.close();
    await owner.close();
  });

  it('refuses every console route without a session, with a malformed token, and with an unknown one', async () => {
    const anonymous = client(h, undefined);
    const none = await anonymous.get('/console/auth/me');
    expect(none.status).toBe(401);
    expect(none.error).toMatchObject({ type: 'authentication_error', code: 'missing_session' });
    const junk = await client(h, 'not-a-session').get('/console/tenants');
    expect(junk.error).toMatchObject({ type: 'authentication_error', code: 'session_invalid' });
    const unknown = await client(h, `cst_${'a'.repeat(43)}`).get('/console/reconcile');
    expect(unknown.status).toBe(401);
    expect(unknown.error?.code).toBe('session_invalid');
    // An API key is not a console session either.
    const key = await client(h, 'sk_sandbox_' + 'A'.repeat(32)).get('/console/tenants');
    expect(key.status).toBe(401);
  });

  it('signs in with the right password, answers /me, and records the sign-in', async () => {
    const { operator, email, password } = await makeOperator(owner.db, 'admin');
    const session = await login(h, email, password);
    expect(session.token).toMatch(/^cst_[A-Za-z0-9_-]{43}$/);
    expect(session.operator).toMatchObject({ id: operator.id, email, role: 'admin' });
    expect(Date.parse(session.expiresAt) - now).toBe(SESSION_TTL_MS);

    const me = await client(h, session.token).get<ConsoleMeResource>('/console/auth/me');
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({ operator: { id: operator.id }, sessionId: session.sessionId });

    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'operator.signed_in'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'operator', actorRef: operator.id, subject: session.sessionId, tenantId: null });
    // The token itself is never stored: only its digest.
    const [row] = await owner.db.select().from(operatorSessions).where(eq(operatorSessions.id, session.sessionId));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(session.token);
  });

  it('refuses a wrong password, an unknown email and a malformed body alike, without saying which', async () => {
    const { email } = await makeOperator(owner.db, 'operator');
    const anonymous = client(h, undefined);
    const wrong = await anonymous.post('/console/auth/login', { email, password: 'nope-nope-nope-nope' }, { idempotencyKey: null });
    const unknown = await anonymous.post('/console/auth/login', { email: 'nobody@purse.test', password: 'nope-nope-nope-nope' }, { idempotencyKey: null });
    const malformed = await anonymous.post('/console/auth/login', { email }, { idempotencyKey: null });
    for (const res of [wrong, unknown, malformed]) {
      expect(res.status).toBe(401);
      expect(res.error).toMatchObject({ type: 'authentication_error', code: 'invalid_credentials', message: 'Email or password is wrong' });
    }
  });

  it('charges failed sign-ins to the address and refuses the address once its bucket is empty, but never a good sign-in', async () => {
    const { email, password } = await makeOperator(owner.db, 'operator');
    const anonymous = client(h, undefined);
    const address = '203.0.113.9';
    for (let i = 0; i < SIGN_IN_LIMIT.burst; i += 1) {
      const res = await anonymous.post('/console/auth/login', { email, password: 'wrong-password-here' }, { idempotencyKey: null, address });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const limited = await anonymous.post('/console/auth/login', { email, password: 'wrong-password-here' }, { idempotencyKey: null, address });
    expect(limited.status).toBe(429);
    expect(limited.error?.type).toBe('rate_limited');
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    // Even the right password is refused from that address now, until the bucket refills...
    const stillLimited = await anonymous.post('/console/auth/login', { email, password }, { idempotencyKey: null, address });
    expect(stillLimited.status).toBe(429);
    // ...but another address is unaffected, and time heals the first.
    await expect(login(h, email, password, '203.0.113.10')).resolves.toBeDefined();
    now += 31_000;
    await expect(login(h, email, password, address)).resolves.toBeDefined();
  });

  it('signs out by revoking the session, which never verifies again', async () => {
    const { api, session } = await consoleClient(h, owner.db, 'operator');
    const out = await api.post('/console/auth/logout', {}, { idempotencyKey: null });
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ signedOut: true, sessionId: session.sessionId });
    const after = await api.get('/console/auth/me');
    expect(after.status).toBe(401);
    expect(after.error?.code).toBe('session_revoked');
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'operator.signed_out'));
    expect(audit).toHaveLength(1);
  });

  it('expires a session after its TTL and touches last_seen_at at most once a minute', async () => {
    const { api, session } = await consoleClient(h, owner.db, 'operator');
    const before = (await owner.db.select().from(operatorSessions).where(eq(operatorSessions.id, session.sessionId)))[0];
    now += LAST_SEEN_WRITE_INTERVAL_MS - 1;
    await api.get('/console/auth/me');
    const untouched = (await owner.db.select().from(operatorSessions).where(eq(operatorSessions.id, session.sessionId)))[0];
    expect(untouched?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());
    now += 2;
    await api.get('/console/auth/me');
    const touched = (await owner.db.select().from(operatorSessions).where(eq(operatorSessions.id, session.sessionId)))[0];
    expect(touched?.lastSeenAt.getTime()).toBe(now);
    now = Date.parse(session.expiresAt);
    const expired = await api.get('/console/auth/me');
    expect(expired.status).toBe(401);
    expect(expired.error?.code).toBe('session_expired');
  });

  it('changes the password with the current one, signs every other session out, and refuses a short or wrong one', async () => {
    const { api, email, password } = await consoleClient(h, owner.db, 'admin');
    const other = await login(h, email, password);
    const short = await api.post('/console/auth/password', { currentPassword: password, newPassword: 'short' }, { idempotencyKey: null });
    expect(short.status).toBe(400);
    expect(short.error?.type).toBe('invalid_request');
    const wrong = await api.post('/console/auth/password', { currentPassword: 'not-the-password-at-all', newPassword: 'a-perfectly-fine-new-password' }, { idempotencyKey: null });
    expect(wrong.status).toBe(401);
    expect(wrong.error?.code).toBe('invalid_credentials');

    const changed = await api.post('/console/auth/password', { currentPassword: password, newPassword: 'a-perfectly-fine-new-password' }, { idempotencyKey: null });
    expect(changed.status).toBe(200);
    expect(changed.data).toEqual({ changed: true, otherSessionsRevoked: 1 });
    expect((await api.get('/console/auth/me')).status).toBe(200);
    expect((await client(h, other.token).get('/console/auth/me')).error?.code).toBe('session_revoked');
    await expect(login(h, email, password)).rejects.toThrow(/401/);
    await expect(login(h, email, 'a-perfectly-fine-new-password')).resolves.toBeDefined();
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'operator.password_changed'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain('a-perfectly-fine-new-password');
  });

  it('keeps admin-only routes from an operator', async () => {
    const { api } = await consoleClient(h, owner.db, 'operator');
    const res = await api.post('/console/rulesets', { body: {} }, { idempotencyKey: null });
    expect(res.status).toBe(403);
    expect(res.error).toMatchObject({ type: 'permission_error', code: 'admin_required' });
  });

  it('refuses a disabled operator, even with a live session', async () => {
    const { api, session, email, password } = await consoleClient(h, owner.db, 'operator');
    await owner.sql`update operators set disabled_at = now() where id = ${session.operator.id}`;
    const res = await api.get('/console/auth/me');
    expect(res.status).toBe(403);
    expect(res.error?.code).toBe('operator_disabled');
    const again = await client(h, undefined).post('/console/auth/login', { email, password }, { idempotencyKey: null });
    expect(again.status).toBe(403);
    expect(again.error?.code).toBe('operator_disabled');
  });
});
