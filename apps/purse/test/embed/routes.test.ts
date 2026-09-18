import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContestResource, EmbedTokenResource, EmbedUserState, EntryResource, UserResource } from '@purse/types';
import { newId } from '@repo/ids';

import { resetAuthCaches } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { issueEmbedToken } from '../../src/auth/embed-tokens';
import { embedTokens } from '../../src/db/schema';
import { CODE_MAX_ATTEMPTS, CODES_PER_WINDOW } from '../../src/embed/signin';
import { addOrigin } from '../../src/embed/origins';
import { SESSION_COOKIE } from '../../src/embed/session';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { bootstrapTenant, client, type ApiResponse, type Bootstrap, type Client } from '../http/client';
import { wipeLedger } from '../ledger/fixtures';

/**
 * The embed's own API (`/v1/embed/*`, spec 4.8): a publishable key and the Purse session
 * cookie. Acceptance criterion 14 (a reused or expired embed token fails) lives here, with
 * the origin allowlist on the session, CORS for the headless read, the phone sign-in, and
 * the flows' endpoints: identity, the entry confirm with its sealed refusals, rewards.
 */
const PARENT = 'http://localhost:3000';

describe('embed API', () => {
  let migrator: Database;
  let h: TestHarness;
  let boot: Bootstrap;
  let secret: Client;
  let pk: Client;
  let ana: UserResource;
  beforeAll(async () => {
    migrator = connectMigrator();
    h = harness();
    await wipeLedger(migrator);
    resetAuthCaches();
    boot = await bootstrapTenant(h.database.db);
    await addOrigin(h.database.db, { tenantId: boot.tenantId, origin: PARENT });
    secret = client(h, boot.operatorKey);
    pk = client(h, boot.publishableKey);
    ana = (await secret.post<UserResource>('/v1/users', { externalId: 'ana', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12', phoneE164: '+15125550101', location: { declaredRegion: 'US-TX' } })).data!;
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await h.close();
  });

  async function mintToken(flow: 'identity' | 'wallet' | 'entry' | 'rewards', userId = ana.id): Promise<string> {
    const minted = await secret.post<EmbedTokenResource>('/v1/embed/tokens', { userId, flow });
    return minted.data?.token ?? '';
  }

  /** The cookie the session endpoint set, as a browser would send it back. */
  function cookieOf(response: ApiResponse): string {
    const header = response.headers.get('set-cookie') ?? '';
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return `${SESSION_COOKIE}=${match?.[1] ?? ''}`;
  }

  async function openSession(flow: 'identity' | 'wallet' | 'entry' | 'rewards' = 'wallet', userId = ana.id): Promise<{ cookie: string; state: EmbedUserState }> {
    const opened = await pk.post<EmbedUserState>('/v1/embed/session', { embedToken: await mintToken(flow, userId), flow, parentOrigin: PARENT });
    expect(opened.status).toBe(201);
    return { cookie: cookieOf(opened), state: opened.data! };
  }

  it('takes only a publishable key, and tells the tenant its allowed origins', async () => {
    const none = await client(h, undefined).get('/v1/embed/origins');
    expect(none.status).toBe(401);
    expect(none.error).toMatchObject({ code: 'missing_api_key' });
    const withSecret = await secret.get('/v1/embed/origins');
    expect(withSecret.status).toBe(401);
    expect(withSecret.error).toMatchObject({ type: 'authentication_error', code: 'publishable_key_required' });
    const origins = await pk.get<{ origins: string[] }>('/v1/embed/origins');
    expect(origins.status).toBe(200);
    expect(origins.data).toEqual({ origins: [PARENT] });
    // The secret-key route on the same prefix still belongs to the secret-key stack.
    const tokens = await pk.post('/v1/embed/tokens', { userId: ana.id, flow: 'wallet' });
    expect(tokens.status).toBe(401);
    expect(tokens.error).toMatchObject({ code: 'secret_key_required' });
  });

  it('redeems an embed token once for a session cookie with the cross-site attributes; reuse, expiry, the wrong flow and a wrong origin fail', async () => {
    const token = await mintToken('wallet');
    const opened = await pk.post<EmbedUserState>('/v1/embed/session', { embedToken: token, flow: 'wallet', parentOrigin: PARENT });
    expect(opened.status).toBe(201);
    expect(opened.data).toMatchObject({ authenticated: true, user: { id: ana.id, externalId: 'ana', displayName: 'Ana Reyes', verification: { state: 'unstarted' }, wallet: [{ asset: 'POINTS', balance: '0' }, { asset: 'CREDIT', balance: '0' }] } });
    expect(opened.data?.user).not.toHaveProperty('phoneE164');
    const setCookie = opened.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/']) expect(setCookie).toContain(attribute);

    // Acceptance 14: the same token again is refused; so is one that expired.
    const reused = await pk.post('/v1/embed/session', { embedToken: token, flow: 'wallet', parentOrigin: PARENT });
    expect(reused.status).toBe(401);
    expect(reused.error).toMatchObject({ type: 'authentication_error', code: 'embed_token_used' });
    // Minted ten minutes ago: five minutes past its life.
    const expiring = await issueEmbedToken(h.database.db, { tenantId: boot.tenantId, userId: ana.id, flow: 'wallet', now: new Date(Date.now() - 10 * 60_000) });
    const expired = await pk.post('/v1/embed/session', { embedToken: expiring.token, flow: 'wallet', parentOrigin: PARENT });
    expect(expired.status).toBe(401);
    expect(expired.error).toMatchObject({ type: 'authentication_error', code: 'embed_token_expired' });
    const unknown = await pk.post('/v1/embed/session', { embedToken: `embt_${'x'.repeat(43)}`, flow: 'wallet', parentOrigin: PARENT });
    expect(unknown.error).toMatchObject({ type: 'authentication_error', code: 'embed_token_invalid' });

    // A token minted for one flow does not open another.
    const wrongFlow = await pk.post('/v1/embed/session', { embedToken: await mintToken('rewards'), flow: 'wallet', parentOrigin: PARENT });
    expect(wrongFlow.status).toBe(403);
    expect(wrongFlow.error).toMatchObject({ type: 'permission_error', code: 'embed_token_wrong_flow' });

    // A parent that is not on the allowlist is refused before the token is touched.
    const fresh = await mintToken('wallet');
    const evil = await pk.post('/v1/embed/session', { embedToken: fresh, flow: 'wallet', parentOrigin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.error).toMatchObject({ type: 'permission_error', code: 'origin_not_allowed' });
    expect((await pk.post('/v1/embed/session', { embedToken: fresh, flow: 'wallet', parentOrigin: PARENT })).status).toBe(201);

    // Another tenant's publishable key cannot redeem this tenant's token, and the attempt still consumes it.
    const other = await bootstrapTenant(h.database.db);
    await addOrigin(h.database.db, { tenantId: other.tenantId, origin: PARENT });
    const stolen = await mintToken('wallet');
    const crossTenant = await client(h, other.publishableKey).post('/v1/embed/session', { embedToken: stolen, flow: 'wallet', parentOrigin: PARENT });
    expect(crossTenant.status).toBe(401);
    expect(crossTenant.error).toMatchObject({ code: 'embed_token_invalid' });
    expect((await pk.post('/v1/embed/session', { embedToken: stolen, flow: 'wallet', parentOrigin: PARENT })).error).toMatchObject({ code: 'embed_token_used' });
  });

  it('reads state with the cookie, headlessly with CORS for an allowed origin only, and never for a forged or foreign cookie', async () => {
    const anonymous = await pk.get<EmbedUserState>('/v1/embed/state');
    expect(anonymous.status).toBe(200);
    expect(anonymous.data).toEqual({ authenticated: false, user: null });

    const { cookie } = await openSession();
    const state = await pk.get<EmbedUserState>('/v1/embed/state', { headers: { Cookie: cookie, Origin: PARENT } });
    expect(state.data).toMatchObject({ authenticated: true, user: { id: ana.id } });
    expect(state.headers.get('access-control-allow-origin')).toBe(PARENT);
    expect(state.headers.get('access-control-allow-credentials')).toBe('true');
    expect(state.headers.get('vary')).toBe('Origin');
    const foreign = await pk.get<EmbedUserState>('/v1/embed/state', { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await h.app.request('/v1/embed/state', { method: 'OPTIONS', headers: { Origin: PARENT, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(PARENT);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const evilPreflight = await h.app.request('/v1/embed/state', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(evilPreflight.status).toBe(204);
    expect(evilPreflight.headers.get('access-control-allow-origin')).toBeNull();

    // A tampered cookie is no session; another tenant's key cannot read this session.
    const tampered = await pk.get<EmbedUserState>('/v1/embed/state', { headers: { Cookie: `${cookie.slice(0, -4)}AAAA` } });
    expect(tampered.data).toEqual({ authenticated: false, user: null });
    const other = await bootstrapTenant(h.database.db);
    const crossTenant = await client(h, other.publishableKey).get<EmbedUserState>('/v1/embed/state', { headers: { Cookie: cookie } });
    expect(crossTenant.data).toEqual({ authenticated: false, user: null });

    const out = await pk.post<EmbedUserState>('/v1/embed/signout', {}, { headers: { Cookie: cookie } });
    expect(out.data).toEqual({ authenticated: false, user: null });
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('signs in with a phone and a one-time code, echoed by the dev sender, and refuses wrong, expired and over-guessed codes', async () => {
    const started = await pk.post<{ sent: true; devCode: string | null; expiresAt: string }>('/v1/embed/signin/start', { phoneE164: '+15125550101' });
    expect(started.status).toBe(200);
    expect(started.data?.sent).toBe(true);
    expect(started.data?.devCode).toMatch(/^\d{6}$/);
    expect(h.lines.some((line) => line['msg'] === 'sms (log sender, not delivered)' && String(line['body']).includes(started.data?.devCode ?? 'never'))).toBe(true);
    const code = started.data?.devCode ?? '';

    const wrong = await pk.post('/v1/embed/signin/verify', { phoneE164: '+15125550101', code: code === '000000' ? '000001' : '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.error).toMatchObject({ type: 'authentication_error', code: 'invalid_code', detail: { attemptsLeft: CODE_MAX_ATTEMPTS - 1 } });
    const otherPhone = await pk.post('/v1/embed/signin/verify', { phoneE164: '+15125550199', code });
    expect(otherPhone.error).toMatchObject({ code: 'invalid_code' });
    const verified = await pk.post<EmbedUserState>('/v1/embed/signin/verify', { phoneE164: '+15125550101', code });
    expect(verified.status).toBe(201);
    expect(verified.data).toMatchObject({ authenticated: true, user: { id: ana.id } });
    expect(verified.headers.get('set-cookie')).toContain('Partitioned');
    const again = await pk.post('/v1/embed/signin/verify', { phoneE164: '+15125550101', code });
    expect(again.error).toMatchObject({ code: 'invalid_code' });

    // A phone nobody has: the answer looks the same and no code exists to verify.
    const nobody = await pk.post<{ sent: boolean; devCode: string | null }>('/v1/embed/signin/start', { phoneE164: '+15125550999' });
    expect(nobody.data).toMatchObject({ sent: true, devCode: null });
    expect((await pk.post('/v1/embed/signin/verify', { phoneE164: '+15125550999', code: '123456' })).error).toMatchObject({ code: 'invalid_code' });

    // Five wrong guesses exhaust a code; five codes in ten minutes is the ceiling.
    const guessable = (await pk.post<{ devCode: string }>('/v1/embed/signin/start', { phoneE164: '+15125550101' })).data?.devCode ?? '';
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) {
      await pk.post('/v1/embed/signin/verify', { phoneE164: '+15125550101', code: guessable === '111111' ? '222222' : '111111' });
    }
    expect((await pk.post('/v1/embed/signin/verify', { phoneE164: '+15125550101', code: guessable })).error).toMatchObject({ code: 'too_many_attempts' });
    for (let i = 2; i < CODES_PER_WINDOW; i += 1) expect((await pk.post('/v1/embed/signin/start', { phoneE164: '+15125550101' })).status).toBe(200);
    const capped = await pk.post('/v1/embed/signin/start', { phoneE164: '+15125550101' });
    expect(capped.status).toBe(429);
    expect(capped.error).toMatchObject({ type: 'rate_limited', code: 'too_many_codes' });
    expect((await pk.post('/v1/embed/signin/start', { phoneE164: '5125550101' })).status).toBe(400);
  });

  it('runs the identity flow for the session user and reports the sealed verification state', async () => {
    const marcus = (await secret.post<UserResource>('/v1/users', { externalId: 'marcus', displayName: 'Marcus Lee', dateOfBirth: '1991-07-30' })).data!;
    const { cookie } = await openSession('identity', marcus.id);
    const noSession = await pk.post('/v1/embed/identity/start', {});
    expect(noSession.status).toBe(401);
    expect(noSession.error).toMatchObject({ type: 'authentication_error', code: 'session_required' });
    const started = await pk.post<{ verification: { state: string; provider: string }; state: EmbedUserState }>('/v1/embed/identity/start', {}, { headers: { Cookie: cookie } });
    expect(started.status).toBe(200);
    expect(started.data?.verification).toMatchObject({ state: 'verified', provider: 'dev' });
    expect(started.data?.state).toMatchObject({ authenticated: true, user: { id: marcus.id, verification: { state: 'verified' } } });
    // No embed token was minted for a flow that is already inside the frame.
    expect(await h.database.db.select().from(embedTokens).where(eq(embedTokens.userId, marcus.id))).toHaveLength(1);
    const again = await pk.post('/v1/embed/identity/start', {}, { headers: { Cookie: cookie } });
    expect(again.status).toBe(409);
    expect(again.error).toMatchObject({ type: 'invalid_state', code: 'already_verified' });
  });

  it('shows a contest and confirms an entry for the session user, with the sealed refusals', async () => {
    const contest = (await secret.post<ContestResource>('/v1/contests', { externalId: 'embed-c', kind: 'tournament', title: 'Saturday doubles', asset: 'POINTS', entryAmount: '100', prizeStructure: { type: 'winner_take_all' } })).data!;
    await secret.post(`/v1/contests/${contest.id}/open`, {});
    const { cookie } = await openSession('entry');
    const shown = await pk.get<ContestResource>(`/v1/embed/contests/${contest.id}`, { headers: { Cookie: cookie } });
    expect(shown.status).toBe(200);
    expect(shown.data).toMatchObject({ id: contest.id, title: 'Saturday doubles', entryAmount: '100', state: 'open', participantCount: 0 });
    expect((await pk.get(`/v1/embed/contests/${contest.id}`)).status).toBe(401);
    expect((await pk.get(`/v1/embed/contests/${newId('cnt')}`, { headers: { Cookie: cookie } })).error).toMatchObject({ code: 'contest_not_found' });

    // Unverified with an empty wallet: refused for funds alone, then for identity once the asset needs it.
    const broke = await pk.post(`/v1/embed/contests/${contest.id}/entries`, {}, { headers: { Cookie: cookie } });
    expect(broke.status).toBe(402);
    expect(broke.error).toMatchObject({ type: 'insufficient_funds', detail: { reasons: ['insufficient_balance'], requiredAction: 'add_funds', rulesetVersion: '2026.09.1' } });
    await secret.post(`/v1/users/${ana.id}/credits`, { asset: 'POINTS', amount: '1000' });
    const entered = await pk.post<EntryResource>(`/v1/embed/contests/${contest.id}/entries`, {}, { headers: { Cookie: cookie } });
    expect(entered.status).toBe(201);
    expect(entered.data).toMatchObject({ contest: { id: contest.id, participantCount: 1, escrowBalance: '100' }, participant: { userId: ana.id, state: 'entered' }, eligibility: { allowed: true } });
    const twice = await pk.post(`/v1/embed/contests/${contest.id}/entries`, {}, { headers: { Cookie: cookie } });
    expect(twice.status).toBe(409);
    expect(twice.error).toMatchObject({ type: 'conflict', code: 'already_entered' });

    const credit = (await secret.post<ContestResource>('/v1/contests', { externalId: 'embed-credit', kind: 'tournament', title: 'Credit cup', asset: 'CREDIT', entryAmount: '100', prizeStructure: { type: 'winner_take_all' } })).data!;
    await secret.post(`/v1/contests/${credit.id}/open`, {});
    await secret.post(`/v1/users/${ana.id}/credits`, { asset: 'CREDIT', amount: '1000' });
    const unverified = await pk.post(`/v1/embed/contests/${credit.id}/entries`, {}, { headers: { Cookie: cookie } });
    expect(unverified.status).toBe(403);
    expect(unverified.error).toMatchObject({ type: 'not_eligible', detail: { reasons: ['identity_unverified'], requiredAction: 'complete_identity' } });
    expect((await pk.get<EmbedUserState>('/v1/embed/state', { headers: { Cookie: cookie } })).data).toMatchObject({ user: { wallet: [{ asset: 'POINTS', balance: '900' }, { asset: 'CREDIT', balance: '1000' }] } });
  });

  it('lists the session user’s settled results as rewards', async () => {
    const { cookie } = await openSession('rewards');
    const before = await pk.get<{ results: unknown[] }>('/v1/embed/rewards', { headers: { Cookie: cookie } });
    expect(before.status).toBe(200);
    expect(before.data).toEqual({ results: [] });
    expect((await pk.get('/v1/embed/rewards')).status).toBe(401);

    const contest = (await secret.post<ContestResource>('/v1/contests', { externalId: 'embed-rewards', kind: 'tournament', title: 'Sunday singles', asset: 'POINTS', entryAmount: '100', prizeStructure: { type: 'winner_take_all' } })).data!;
    await secret.post(`/v1/contests/${contest.id}/open`, {});
    await secret.post(`/v1/contests/${contest.id}/entries`, { userId: ana.id });
    await secret.post(`/v1/contests/${contest.id}/lock`, {});
    await secret.post(`/v1/contests/${contest.id}/start`, {});
    await secret.post(`/v1/contests/${contest.id}/scores`, { scores: [{ userId: ana.id, score: 21, attemptFinished: true }] });
    const preview = await secret.get<{ payoutHash: string }>(`/v1/contests/${contest.id}/preview`);
    const closed = await secret.post(`/v1/contests/${contest.id}/close`, { payoutHash: preview.data?.payoutHash });
    expect(closed.status).toBe(200);
    const rewards = await pk.get<{ results: Array<Record<string, unknown>> }>('/v1/embed/rewards', { headers: { Cookie: cookie } });
    expect(rewards.data?.results).toEqual([expect.objectContaining({ contestId: contest.id, title: 'Sunday singles', asset: 'POINTS', placement: 1, payoutAmount: '100', score: '21' })]);
  });
});
