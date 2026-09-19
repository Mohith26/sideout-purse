import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as listDemo, POST as demoSignIn } from '../../src/app/api/auth/demo/route';
import { POST as logout } from '../../src/app/api/auth/logout/route';
import { POST as requestCode } from '../../src/app/api/auth/request-code/route';
import { GET as me } from '../../src/app/api/me/route';
import { auditLog, users } from '../../src/db/schema';
import { buildSeed, writeSeed } from '../../src/db/seed';
import { DEMO_ACCOUNT_KEYS, demoRoster, type DemoAccountKey } from '../../src/db/seed/demo';
import { env } from '../../src/env';
import type { DemoAccount } from '../../src/lib/demo-accounts';
import { DEMO_AUDIT_ACTION, DEMO_SIGN_IN_LIMITS } from '../../src/server/auth/demo';
import { verifySession } from '../../src/server/auth/session';
import { resetAppContext } from '../../src/server/context';
import { data, errorOf, nextPhone, request, testDatabase, truncateAll, type Database } from '../helpers';

const ANCHOR = new Date('2026-09-19T16:00:00.000Z');

type SignedIn = { user: { id: string; displayName: string; role: string }; account: DemoAccountKey; href: string; demo: boolean; sessionExpiresAt: string };

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`): absent
 * while the switch is off, the seeded roster with each account's live state while it is
 * on, a sign-in that is a normal session marked as a demo and audited, unknown accounts
 * refused, both rate limits, and the phone sign-in untouched either way.
 */
describe('demo accounts', () => {
  let database: Database;
  const dataset = buildSeed({ anchor: ANCHOR });
  const roster = demoRoster(dataset, ANCHOR);

  const switchOn = () => resetAppContext({ env: { ...env(), demoAccounts: true } });
  const switchOff = () => resetAppContext();
  const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  beforeAll(async () => {
    database = testDatabase();
    await truncateAll(database);
    await writeSeed(database.db, dataset);
  });
  afterAll(async () => {
    await truncateAll(database);
    await database.close();
  });

  it('does not exist while the switch is off: both handlers answer 404, whatever the body', async () => {
    switchOff();
    expect(env().demoAccounts).toBe(false);
    expect((await listDemo(request('GET', '/api/auth/demo'))).status).toBe(404);
    const refused = await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'organizer' } }));
    expect(refused.status).toBe(404);
    expect((await errorOf(refused)).code).toBe('not_found');
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(await database.db.select().from(auditLog).where(eq(auditLog.action, DEMO_AUDIT_ACTION))).toHaveLength(0);
  });

  it('lists the six curated accounts with their live state, in picker order, from the seeded rows', async () => {
    switchOn();
    const response = await listDemo(request('GET', '/api/auth/demo'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { accounts } = await data<{ accounts: DemoAccount[] }>(response);
    expect(accounts.map((a) => a.key)).toEqual([...DEMO_ACCOUNT_KEYS]);
    const byKey = Object.fromEntries(accounts.map((a) => [a.key, a])) as Record<DemoAccountKey, DemoAccount>;
    for (const key of DEMO_ACCOUNT_KEYS) {
      const [user] = await database.db.select().from(users).where(eq(users.phoneE164, roster.phones[key]));
      expect(byKey[key].userId).toBe(user?.id);
      expect(byKey[key].displayName).toBe(user?.displayName);
      expect(JSON.stringify(byKey[key])).not.toContain(roster.phones[key]);
    }

    const a = byKey.captain_a;
    const b = byKey.captain_b;
    expect(a.detail).toMatchObject({ kind: 'match', matchStatus: 'awaiting_scores', round: 'Quarterfinal', ownScorelineIn: true, opponentScorelineIn: false });
    expect(b.detail).toMatchObject({ kind: 'match', matchStatus: 'awaiting_scores', ownScorelineIn: false, opponentScorelineIn: true });
    expect(a.detail.kind === 'match' && b.detail.kind === 'match' && a.detail.matchId === b.detail.matchId).toBe(true);
    expect(a.detail.kind === 'match' && b.detail.kind === 'match' && a.detail.opponentName === b.detail.teamName).toBe(true);
    expect(a.href).toMatch(/^\/m\/mch_/);
    expect(a.tournament.slug).toBe(roster.liveSlug);

    expect(byKey.registrant.detail).toMatchObject({ kind: 'register', teamStatus: 'forming', holdsPlace: false, entryDonationCents: '4000' });
    expect(byKey.registrant.href).toBe(`/t/${roster.registrantSlug}/register`);
    expect(byKey.organizer.detail).toEqual({ kind: 'organizer', disputes: 2 });
    expect(byKey.organizer.role).toBe('organizer');
    expect(byKey.organizer.href).toBe('/organizer/events');
    // The Purse-state players' cards read what Sideout last heard; with no Purse walked here, nothing yet.
    expect(byKey.refused.detail).toEqual({ kind: 'purse', linked: false, verificationState: null });
    expect(byKey.verifying.detail).toEqual({ kind: 'purse', linked: false, verificationState: null });
    expect(byKey.refused.href).toBe('/me');

    // What the seed's Purse walk mirrors is what the card shows.
    const [refused] = await database.db.select().from(users).where(eq(users.phoneE164, roster.phones.refused));
    await database.db.update(users).set({ purseUserId: 'usr_demo_refused', purseVerificationState: 'rejected' }).where(eq(users.id, refused?.id ?? ''));
    const again = await data<{ accounts: DemoAccount[] }>(await listDemo(request('GET', '/api/auth/demo')));
    expect(again.accounts.find((x) => x.key === 'refused')?.detail).toEqual({ kind: 'purse', linked: true, verificationState: 'rejected' });
  });

  it('signs in as a roster account: a normal session marked as a demo, an audit row, and the profile loads', async () => {
    switchOn();
    const response = await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'captain_b' } }));
    expect(response.status).toBe(200);
    const body = await data<SignedIn>(response);
    expect(body.demo).toBe(true);
    expect(body.account).toBe('captain_b');
    expect(body.href).toMatch(/^\/m\/mch_/);
    expect(body.user.role).toBe('player');
    expect(body.user).not.toHaveProperty('phoneE164');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^sideout_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    const token = cookieOf(response).replace('sideout_session=', '');
    expect(verifySession(token, env().sessionSecret, new Date())).toEqual({ userId: body.user.id, via: 'demo' });

    const [user] = await database.db.select().from(users).where(eq(users.id, body.user.id));
    expect(user?.phoneE164).toBe(roster.phones.captain_b);
    const trail = await database.db.select().from(auditLog).where(and(eq(auditLog.action, DEMO_AUDIT_ACTION), eq(auditLog.subjectId, body.user.id)));
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actorKind: 'player', actorUserId: body.user.id, subjectType: 'user', detail: { account: 'captain_b', method: 'demo_accounts' } });

    const profile = await me(request('GET', '/api/me', { cookie: cookieOf(response) }));
    expect(profile.status).toBe(200);
    expect((await data<{ user: { id: string } }>(profile)).user.id).toBe(body.user.id);

    // Sign-out ends a demo session like any other.
    const out = await logout(request('POST', '/api/auth/logout', { body: {}, cookie: cookieOf(response) }));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    const organizer = await data<SignedIn>(await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'organizer' } })));
    expect(organizer.user.role).toBe('organizer');
    expect(organizer.href).toBe('/organizer/events');
  });

  it('refuses anything but a roster key: an unknown key, a user id, a phone, an extra field', async () => {
    switchOn();
    for (const body of [{ account: 'admin' }, { account: 'sou_01' }, { account: roster.phones.organizer }, { account: 'organizer', userId: 'sou_x' }, {}]) {
      const response = await demoSignIn(request('POST', '/api/auth/demo', { body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(response)).code).toBe('validation_failed');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    // A roster key whose seeded rows are gone is not found and issues no session.
    const [verifying] = await database.db.select().from(users).where(eq(users.phoneE164, roster.phones.verifying));
    await database.db.update(users).set({ phoneE164: nextPhone() }).where(eq(users.id, verifying?.id ?? ''));
    const gone = await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'verifying' } }));
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe('demo_account_unavailable');
    expect(gone.headers.get('set-cookie')).toBeNull();
    await database.db.update(users).set({ phoneE164: roster.phones.verifying }).where(eq(users.id, verifying?.id ?? ''));
    expect((await listDemo(request('GET', '/api/auth/demo'))).status).toBe(200);
  });

  it('rate-limits sign-ins per address and for the whole process, and charges nothing on a refusal', async () => {
    switchOn();
    const from = (address: string) => ({ 'x-forwarded-for': address });
    for (let i = 0; i < DEMO_SIGN_IN_LIMITS.perAddress.limit; i += 1) {
      expect((await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'captain_a' }, headers: from('203.0.113.7') }))).status).toBe(200);
    }
    const limited = await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'captain_a' }, headers: from('203.0.113.7') }));
    expect(limited.status).toBe(429);
    const error = await errorOf(limited);
    expect(error.code).toBe('too_many_requests');
    expect(error.detail).toMatchObject({ scope: 'address' });
    expect(limited.headers.get('set-cookie')).toBeNull();
    // Another address is unaffected, and the refusal above wrote no audit row.
    expect((await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'captain_a' }, headers: from('203.0.113.8') }))).status).toBe(200);
    const [captainA] = await database.db.select().from(users).where(eq(users.phoneE164, roster.phones.captain_a));
    const trail = await database.db.select().from(auditLog).where(and(eq(auditLog.action, DEMO_AUDIT_ACTION), eq(auditLog.subjectId, captainA?.id ?? '')));
    expect(trail).toHaveLength(DEMO_SIGN_IN_LIMITS.perAddress.limit + 1);

    // The process-wide cap: fresh limiters, then spread the budget across addresses.
    switchOn();
    for (let i = 0; i < DEMO_SIGN_IN_LIMITS.global.limit; i += 1) {
      const response = await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'organizer' }, headers: from(`198.51.100.${1 + (i % 200)}`) }));
      expect(response.status, `sign-in ${i}`).toBe(200);
    }
    const exhausted = await demoSignIn(request('POST', '/api/auth/demo', { body: { account: 'organizer' }, headers: from('198.51.100.250') }));
    expect(exhausted.status).toBe(429);
    expect((await errorOf(exhausted)).detail).toMatchObject({ scope: 'global' });
  }, 60_000);

  it('leaves the phone sign-in exactly as it is, on or off', async () => {
    for (const setup of [switchOn, switchOff]) {
      setup();
      const issued = await requestCode(request('POST', '/api/auth/request-code', { body: { phone: nextPhone() } }));
      expect(issued.status).toBe(200);
      expect(await data<{ code?: string }>(issued)).toMatchObject({ code: expect.stringMatching(/^\d{6}$/) as string });
    }
    switchOff();
  });
});
