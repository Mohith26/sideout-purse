import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, RATE_LIMIT_LIMIT_HEADER, RATE_LIMIT_REMAINING_HEADER, REQUEST_ID_HEADER, RETRY_AFTER_HEADER, type UserResource } from '@purse/types';

import { resetAuthCaches, revokeApiKey } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { idempotencyKeys, journalEntries, users } from '../../src/db/schema';
import { TokenBuckets } from '../../src/http/rate-limit';
import { purgeExpired } from '../../src/maintenance/purge';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { bootstrapTenant, client, type Bootstrap } from './client';

/**
 * The v1 middleware stack (spec 4.7): bearer authentication, the operator scope, the
 * `Idempotency-Key` contract (identical replay, conflict on a different body, a stored
 * refusal, nothing stored on a 5xx, the 30-day purge), and the per-key rate limit with
 * `Retry-After`.
 */
describe('bearer authentication', () => {
  let migrator: Database;
  let h: TestHarness;
  let boot: Bootstrap;
  beforeAll(() => {
    migrator = connectMigrator();
    h = harness();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    resetAuthCaches();
    boot = await bootstrapTenant(h.database.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await h.close();
  });

  it('refuses no key, a malformed header, an unknown key, a publishable key and a revoked key, each with its own code', async () => {
    const anonymous = client(h, undefined);
    const none = await anonymous.get('/v1/users/usr_x');
    expect(none.status).toBe(401);
    expect(none.error).toMatchObject({ type: 'authentication_error', code: 'missing_api_key' });
    const basic = await anonymous.get('/v1/users/usr_x', { headers: { Authorization: 'Basic abc' } });
    expect(basic.error).toMatchObject({ type: 'authentication_error', code: 'missing_api_key' });
    const unknown = await client(h, `sk_sandbox_${'Z'.repeat(32)}`).get('/v1/users/usr_x');
    expect(unknown.status).toBe(401);
    expect(unknown.error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' });
    const publishable = await client(h, boot.publishableKey).get('/v1/users/usr_x');
    expect(publishable.status).toBe(401);
    expect(publishable.error).toMatchObject({ type: 'authentication_error', code: 'secret_key_required' });
    await revokeApiKey(h.database.db, { tenantId: boot.tenantId, keyId: boot.keyIds.plain, actor: { kind: 'operator' } });
    const revoked = await client(h, boot.plainKey).get('/v1/users/usr_x');
    expect(revoked.status).toBe(401);
    expect(revoked.error).toMatchObject({ type: 'authentication_error', code: 'api_key_revoked' });
    // The health and internal routes under /v1 take no API key.
    expect((await anonymous.get('/v1/health')).status).toBe(200);
    expect((await anonymous.get('/v1/internal/reconcile')).status).toBe(200);
  });

  it('a plain secret key is a tenant actor and cannot issue credits; an operator key can', async () => {
    const plain = client(h, boot.plainKey);
    const created = await plain.post<UserResource>('/v1/users', { externalId: 'u1' });
    expect(created.status).toBe(201);
    const userId = created.data?.id ?? '';
    const forbidden = await plain.post(`/v1/users/${userId}/credits`, { asset: 'POINTS', amount: '100' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.error).toMatchObject({ type: 'permission_error', code: 'operator_scope_required' });
    expect(await h.database.db.select().from(journalEntries)).toEqual([]);
    const granted = await client(h, boot.operatorKey).post(`/v1/users/${userId}/credits`, { asset: 'POINTS', amount: '100' });
    expect(granted.status).toBe(201);
    expect(granted.data).toMatchObject({ userId, asset: 'POINTS', amount: '100', balance: '100' });
    // The request log names the tenant and key, and the request id round-trips.
    const line = h.lines.find((each) => each['msg'] === 'request' && each['path'] === `/v1/users/${userId}/credits` && each['status'] === 201);
    expect(line).toMatchObject({ tenantId: boot.tenantId, apiKeyId: boot.keyIds.operator, environment: 'sandbox' });
    expect(granted.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('idempotency middleware', () => {
  let migrator: Database;
  let h: TestHarness;
  let boot: Bootstrap;
  beforeAll(() => {
    migrator = connectMigrator();
    h = harness({ max: 8 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    resetAuthCaches();
    boot = await bootstrapTenant(h.database.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await h.close();
  });

  it('requires a well-formed key on every mutation and none on a read', async () => {
    const api = client(h, boot.plainKey);
    const missing = await api.post('/v1/users', { externalId: 'u1' }, { idempotencyKey: null });
    expect(missing.status).toBe(400);
    expect(missing.error).toMatchObject({ type: 'invalid_request', code: 'missing_idempotency_key' });
    const bad = await api.post('/v1/users', { externalId: 'u1' }, { idempotencyKey: 'has space' });
    expect(bad.error).toMatchObject({ type: 'invalid_request', code: 'invalid_idempotency_key' });
    const long = await api.post('/v1/users', { externalId: 'u1' }, { idempotencyKey: 'k'.repeat(201) });
    expect(long.error).toMatchObject({ code: 'invalid_idempotency_key' });
    expect(await h.database.db.select().from(users)).toEqual([]);
    const created = await api.post<UserResource>('/v1/users', { externalId: 'u1' });
    expect(created.status).toBe(201);
    const read = await api.get(`/v1/users/${created.data?.id ?? ''}`, { idempotencyKey: null });
    expect(read.status).toBe(200);
  });

  it('replays the stored response byte for byte and creates nothing new; a different body under the key is a conflict', async () => {
    const api = client(h, boot.operatorKey);
    const k = key('idem');
    const first = await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k });
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const replay = await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k });
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(replay.raw).toEqual(first.raw);
    expect(await h.database.db.select().from(users)).toHaveLength(1);

    const conflict = await api.post('/v1/users', { externalId: 'u1', displayName: 'Anna' }, { idempotencyKey: k });
    expect(conflict.status).toBe(409);
    expect(conflict.error).toMatchObject({ type: 'conflict', code: 'idempotency_key_reused', detail: { idempotencyKey: k, endpoint: 'POST /v1/users' } });
    // The same key on another endpoint is a different request too, and another tenant's use of it is invisible.
    const elsewhere = await api.post('/v1/embed/tokens', { userId: first.data?.id, flow: 'wallet' }, { idempotencyKey: k });
    expect(elsewhere.status).toBe(409);
    const other = await bootstrapTenant(h.database.db);
    const theirs = await client(h, other.plainKey).post('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k });
    expect(theirs.status).toBe(201);
    expect(theirs.data).not.toEqual(first.data);

    // Money: a replayed credit posts one journal entry, and the balance moved once.
    const userId = first.data?.id ?? '';
    const c = key('credit');
    const credit = await api.post(`/v1/users/${userId}/credits`, { asset: 'POINTS', amount: 250 }, { idempotencyKey: c });
    const again = await api.post(`/v1/users/${userId}/credits`, { asset: 'POINTS', amount: 250 }, { idempotencyKey: c });
    expect(again.raw).toEqual(credit.raw);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await h.database.db.select().from(journalEntries)).toHaveLength(1);
    const wallet = await api.get<{ balances: Array<{ asset: string; balance: string }> }>(`/v1/users/${userId}/wallet`);
    expect(wallet.data?.balances.find((each) => each.asset === 'POINTS')?.balance).toBe('250');
  });

  it('stores a refusal and replays it; stores nothing for a 5xx or a 429', async () => {
    const api = client(h, boot.operatorKey);
    const k = key('refused');
    const refused = await api.post('/v1/users/usr_nope/credits', { asset: 'POINTS', amount: '1' }, { idempotencyKey: k });
    expect(refused.status).toBe(400);
    const replay = await api.post('/v1/users/usr_nope/credits', { asset: 'POINTS', amount: '1' }, { idempotencyKey: k });
    expect(replay.status).toBe(400);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(replay.raw).toEqual(refused.raw);
    const rows = await h.database.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, boot.tenantId), eq(idempotencyKeys.scope, 'http')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: k, operation: 'POST /v1/users/:id/credits', responseStatus: 400 });

    // A 5xx: the identity vendor is down. Nothing is stored and the verification the
    // handler had begun is rolled back, so a retry under the same key performs the request.
    const down = harness({ providers: { identity: { name: 'dev', verify: () => Promise.reject(new Error('vendor timeout')) } } });
    try {
      const downApi = client(down, boot.operatorKey);
      const user = await downApi.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Ana', dateOfBirth: '1990-01-01' });
      const userId = user.data?.id ?? '';
      const e = key('verify');
      const failed = await downApi.post(`/v1/users/${userId}/verification`, {}, { idempotencyKey: e });
      expect(failed.status).toBe(500);
      expect(failed.error).toMatchObject({ type: 'internal_error', code: 'provider_unavailable' });
      expect(failed.error?.message).not.toContain('vendor timeout');
      const stored = await h.database.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, boot.tenantId), eq(idempotencyKeys.key, e)));
      expect(stored).toEqual([]);
      expect((await downApi.get<UserResource>(`/v1/users/${userId}`)).data?.verification.state).toBe('unstarted');
      const retried = await api.post(`/v1/users/${userId}/verification`, {}, { idempotencyKey: e });
      expect(retried.status).toBe(201);
      expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    } finally {
      await down.close();
    }
  });

  it('concurrent identical requests perform the work once and all receive the same response', async () => {
    const api = client(h, boot.operatorKey);
    const user = await api.post<UserResource>('/v1/users', { externalId: 'u1' });
    const userId = user.data?.id ?? '';
    const k = key('race');
    const results = await Promise.all(Array.from({ length: 6 }, () => api.post(`/v1/users/${userId}/credits`, { asset: 'POINTS', amount: '40' }, { idempotencyKey: k })));
    expect(new Set(results.map((each) => each.status))).toEqual(new Set([201]));
    for (const each of results) expect(each.raw).toEqual(results[0]?.raw);
    expect(results.filter((each) => each.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true')).toHaveLength(5);
    expect(await h.database.db.select().from(journalEntries)).toHaveLength(1);
  });

  it('keys are remembered for 30 days and then purged, after which the key is fresh', async () => {
    const api = client(h, boot.operatorKey);
    const k = key('ttl');
    const first = await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k });
    await migrator.sql`update idempotency_keys set created_at = now() - interval '31 days' where key = ${k}`;
    expect((await api.post('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k })).headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    const purged = await purgeExpired(migrator.db);
    expect(purged.idempotencyKeys).toBe(1);
    const fresh = await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Anna' }, { idempotencyKey: k });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(fresh.data?.id).toBe(first.data?.id);
    expect(fresh.data?.displayName).toBe('Anna');
  });

  it('rejects a body that is not a JSON object before any handler runs', async () => {
    const api = client(h, boot.plainKey);
    const invalid = await api.post('/v1/users', undefined, { rawBody: '{not json' });
    expect(invalid.status).toBe(400);
    expect(invalid.error).toMatchObject({ type: 'invalid_request', code: 'invalid_json' });
    const array = await api.post('/v1/users', undefined, { rawBody: '[1]' });
    expect(array.error).toMatchObject({ code: 'invalid_body' });
    const text = await api.post('/v1/users', undefined, { rawBody: 'externalId=u1', headers: { 'content-type': 'text/plain' } });
    expect(text.status).toBe(415);
    expect(text.error).toMatchObject({ code: 'unsupported_media_type' });
    const huge = await api.post('/v1/users', undefined, { rawBody: `{"externalId":"${'x'.repeat(1_100_000)}"}` });
    expect(huge.status).toBe(413);
    expect(huge.error).toMatchObject({ code: 'body_too_large' });
    expect(await h.database.db.select().from(users)).toEqual([]);
    expect(await h.database.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'http'))).toEqual([]);
  });
});

describe('rate limiting', () => {
  it('a token bucket refills at the configured rate and reports how long to wait', () => {
    const buckets = new TokenBuckets({ burst: 3, perSecond: 2 });
    expect(buckets.take('a', 0)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(buckets.take('a', 0)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(buckets.take('a', 0)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(buckets.take('a', 0)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 500 });
    expect(buckets.take('b', 0).allowed).toBe(true);
    expect(buckets.take('a', 250)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 250 });
    expect(buckets.take('a', 500)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(buckets.take('a', 10_000)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(() => new TokenBuckets({ burst: 0, perSecond: 1 })).toThrow(RangeError);
  });

  it('answers 429 with Retry-After and the sealed error once a key’s burst is spent, per key, before authentication', async () => {
    const migrator = connectMigrator();
    let now = 0;
    const h = harness({ rateLimit: { burst: 2, perSecond: 1 }, clock: () => now });
    try {
      await wipeLedger(migrator);
      resetAuthCaches();
      const boot = await bootstrapTenant(h.database.db);
      const api = client(h, boot.plainKey);
      const first = await api.get('/v1/users/usr_x');
      expect(first.status).toBe(400);
      expect(first.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('2');
      expect(first.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('1');
      await api.get('/v1/users/usr_x');
      const limited = await api.get('/v1/users/usr_x');
      expect(limited.status).toBe(429);
      expect(limited.headers.get(RETRY_AFTER_HEADER)).toBe('1');
      expect(limited.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('0');
      expect(limited.error).toMatchObject({ type: 'rate_limited', code: 'too_many_requests', detail: { retryAfterSeconds: 1, limit: 2 } });
      // Another key has its own bucket; guessing with a bad key is throttled on the prefix presented.
      expect((await client(h, boot.operatorKey).get('/v1/users/usr_x')).status).toBe(400);
      const guess = `sk_sandbox_${'Q'.repeat(32)}`;
      expect((await client(h, guess).get('/v1/users/usr_x')).status).toBe(401);
      expect((await client(h, guess).get('/v1/users/usr_x')).status).toBe(401);
      expect((await client(h, guess).get('/v1/users/usr_x')).status).toBe(429);
      // A second later one token is back; a limited write stored nothing under its key.
      now = 1_000;
      const write = await api.post('/v1/users', { externalId: 'u1' }, { idempotencyKey: 'rl-1' });
      expect(write.status).toBe(201);
      const again = await api.post('/v1/users', { externalId: 'u2' }, { idempotencyKey: 'rl-2' });
      expect(again.status).toBe(429);
      expect(await h.database.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'rl-2'))).toEqual([]);
      expect(again.headers.get(IDEMPOTENCY_KEY_HEADER)).toBeNull();
    } finally {
      await wipeLedger(migrator);
      await migrator.close();
      await h.close();
    }
  });
});
