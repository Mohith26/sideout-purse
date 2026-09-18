import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, RATE_LIMIT_LIMIT_HEADER, RATE_LIMIT_REMAINING_HEADER, REQUEST_ID_HEADER, RETRY_AFTER_HEADER, type UserResource } from '@purse/types';

import { resetAuthCaches, revokeApiKey } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { idempotencyKeys, idempotencyReservations, journalEntries, users } from '../../src/db/schema';
import { MAX_BODY_BYTES } from '../../src/http/body';
import { httpRequestHash } from '../../src/http/idempotency';
import { MAX_BUCKETS, TokenBuckets } from '../../src/http/rate-limit';
import { purgeExpired } from '../../src/maintenance/purge';
import type { IdentityProvider, VerificationResult } from '../../src/providers';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { bootstrapTenant, client, type Bootstrap } from './client';

/**
 * The v1 middleware stack (spec 4.7): bearer authentication, the operator scope, the
 * `Idempotency-Key` contract (identical replay, conflict on a different body, a stored
 * refusal, nothing stored on a 5xx, a claim held without a connection while the request
 * runs, the 30-day purge), the body cap, and the rate limits: per key once authenticated,
 * per address for failed authentications, with `Retry-After`.
 */

/** An identity provider that answers only when the test lets it, and says when it was asked. */
function gatedIdentity(): IdentityProvider & { asked: Promise<void>; answer: (result: VerificationResult) => void } {
  let asked: () => void = () => undefined;
  let answer: (result: VerificationResult) => void = () => undefined;
  const askedPromise = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const result = new Promise<VerificationResult>((resolve) => {
    answer = resolve;
  });
  return {
    name: 'dev',
    verify: () => {
      asked();
      return result;
    },
    asked: askedPromise,
    answer,
  };
}

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

    // A 5xx: the identity vendor is down. Nothing is stored; the user is left `pending`
    // (the step before the vendor call committed on its own, and pending may be started
    // again), so a retry under the same key performs the request.
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
      expect((await downApi.get<UserResource>(`/v1/users/${userId}`)).data?.verification.state).toBe('pending');
      // The claim on the key was released with the 5xx, so the retry is performed at once rather than after the claim's expiry.
      const [claim] = await h.database.db.select().from(idempotencyReservations).where(and(eq(idempotencyReservations.tenantId, boot.tenantId), eq(idempotencyReservations.key, e)));
      expect(claim?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      const retried = await api.post<{ verification: { state: string } }>(`/v1/users/${userId}/verification`, {}, { idempotencyKey: e });
      expect(retried.status).toBe(201);
      expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
      expect(retried.data?.verification.state).toBe('verified');
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

  it('holds the key as a claim, not a connection or a row lock, while the identity provider is asked; a concurrent replay waits for the answer', async () => {
    const identity = gatedIdentity();
    // One pool connection: were the request holding it across the provider call, nothing else could run.
    const gated = harness({ providers: { identity }, max: 1 });
    try {
      const api = client(gated, boot.operatorKey);
      const user = await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Ana', dateOfBirth: '1990-01-01' });
      const userId = user.data?.id ?? '';
      const k = key('verify');
      const inFlight = api.post<{ verification: { state: string } }>(`/v1/users/${userId}/verification`, {}, { idempotencyKey: k });
      await identity.asked;

      // The verification row is `pending` and committed, and nobody holds its lock.
      const [pending] = await migrator.sql<Array<{ state: string }>>`select state from user_verification where user_id = ${userId} for update nowait`;
      expect(pending?.state).toBe('pending');
      // The one connection is free: a read on the same harness completes while the provider is still thinking.
      const read = await api.get<UserResource>(`/v1/users/${userId}`);
      expect(read.status).toBe(200);
      expect(read.data?.verification.state).toBe('pending');
      // The key is claimed for the request in flight, with an expiry, and nothing is stored yet.
      const [claim] = await gated.database.db.select().from(idempotencyReservations).where(and(eq(idempotencyReservations.tenantId, boot.tenantId), eq(idempotencyReservations.key, k)));
      expect(claim).toMatchObject({ operation: 'POST /v1/users/:id/verification' });
      expect(claim?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await gated.database.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, boot.tenantId), eq(idempotencyKeys.key, k)))).toEqual([]);
      // A replay under the live claim waits rather than starting a second verification; a different request under it is a conflict at once.
      const replay = api.post<{ verification: { state: string } }>(`/v1/users/${userId}/verification`, {}, { idempotencyKey: k });
      expect(await Promise.race([replay.then(() => 'answered'), sleep(200).then(() => 'waiting')])).toBe('waiting');
      const reused = await api.post('/v1/users', { externalId: 'u2' }, { idempotencyKey: k });
      expect(reused.status).toBe(409);
      expect(reused.error).toMatchObject({ code: 'idempotency_key_reused', detail: { endpoint: 'POST /v1/users/:id/verification' } });

      identity.answer({ outcome: 'verified', providerRef: 'dev:ok' });
      const first = await inFlight;
      expect(first.status).toBe(201);
      expect(first.data?.verification.state).toBe('verified');
      const second = await replay;
      expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
      expect(second.raw).toEqual(first.raw);
      expect(gated.lines.filter((line) => line['msg'] === 'idempotent replay')).toHaveLength(1);
    } finally {
      await gated.close();
    }
  });

  it('a claim left by a crashed request is honoured until it expires and then retried', async () => {
    const quick = harness({ inProgressWaitMs: 150 });
    try {
      const api = client(quick, boot.operatorKey);
      const k = key('crashed');
      const body = { externalId: 'crashed' };
      const hash = httpRequestHash('POST', '/v1/users', body);
      // A request that claimed the key and died: its claim is live and nothing is stored.
      await migrator.db.insert(idempotencyReservations).values({ tenantId: boot.tenantId, key: k, operation: 'POST /v1/users', requestHash: hash, expiresAt: sql`now() + interval '1 minute'` });
      const waited = await api.post('/v1/users', body, { idempotencyKey: k });
      expect(waited.status).toBe(409);
      expect(waited.error).toMatchObject({ type: 'conflict', code: 'idempotency_key_in_progress', detail: { idempotencyKey: k, endpoint: 'POST /v1/users' } });
      expect(waited.headers.get(RETRY_AFTER_HEADER)).toBe('1');
      expect(await quick.database.db.select().from(users)).toEqual([]);
      // Once the claim has expired, the retry takes it over and performs the request.
      await migrator.db.update(idempotencyReservations).set({ expiresAt: sql`now()` }).where(and(eq(idempotencyReservations.tenantId, boot.tenantId), eq(idempotencyReservations.key, k)));
      const performed = await api.post<UserResource>('/v1/users', body, { idempotencyKey: k });
      expect(performed.status).toBe(201);
      expect(performed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
      const [claim] = await quick.database.db.select().from(idempotencyReservations).where(and(eq(idempotencyReservations.tenantId, boot.tenantId), eq(idempotencyReservations.key, k)));
      expect(claim?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect((await api.post<UserResource>('/v1/users', body, { idempotencyKey: k })).headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
      expect(await quick.database.db.select().from(users)).toHaveLength(1);
    } finally {
      await quick.close();
    }
  });

  it('keys are remembered for 30 days and then purged, after which the key is fresh', async () => {
    const api = client(h, boot.operatorKey);
    const k = key('ttl');
    const first = await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k });
    await migrator.sql`update idempotency_keys set created_at = now() - interval '31 days' where key = ${k}`;
    expect((await api.post('/v1/users', { externalId: 'u1', displayName: 'Ana' }, { idempotencyKey: k })).headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    await migrator.sql`update idempotency_reservations set reserved_at = now() - interval '31 days' where key = ${k}`;
    const purged = await purgeExpired(migrator.db);
    expect(purged.idempotencyKeys).toBe(1);
    expect(purged.idempotencyReservations).toBe(1);
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
    // A body with no declared length is refused the moment it passes the cap, not once it has all arrived.
    const chunk = new Uint8Array(65_536).fill(0x78);
    const chunks = Math.ceil((4 * MAX_BODY_BYTES) / chunk.byteLength);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const chunked = await api.post('/v1/users', undefined, { rawBody: stream });
    expect(chunked.status).toBe(413);
    expect(chunked.error).toMatchObject({ code: 'body_too_large' });
    expect(pulled).toBeLessThan(chunks / 2);
    expect(await h.database.db.select().from(users)).toEqual([]);
    expect(await h.database.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'http'))).toEqual([]);
  });
});

describe('rate limiting', () => {
  it('a token bucket refills at the configured rate and reports how long to wait', () => {
    const buckets = new TokenBuckets({ burst: 3, perSecond: 2 });
    expect(buckets.available('a', 0)).toBe(3);
    expect(buckets.take('a', 0)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(buckets.take('a', 0)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(buckets.take('a', 0)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(buckets.available('a', 0)).toBe(0);
    expect(buckets.take('a', 0)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 500 });
    expect(buckets.take('b', 0).allowed).toBe(true);
    expect(buckets.take('a', 250)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 250 });
    expect(buckets.available('a', 500)).toBe(1);
    expect(buckets.take('a', 500)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(buckets.take('a', 10_000)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(() => new TokenBuckets({ burst: 0, perSecond: 1 })).toThrow(RangeError);
  });

  it('holds at most MAX_BUCKETS buckets, dropping idle ones first and then the least recently used', () => {
    const buckets = new TokenBuckets({ burst: 1, perSecond: 1 });
    buckets.take('idle', 0);
    const later = 11 * 60_000;
    for (let i = 0; i < MAX_BUCKETS; i += 1) buckets.take(`k${i}`, later);
    expect(buckets.size).toBe(MAX_BUCKETS);
    // `idle` went with the first eviction; `k0` is the oldest of the rest and goes next, while a bucket just used stays.
    expect(buckets.take('k1', later).allowed).toBe(false);
    buckets.take('fresh', later);
    expect(buckets.size).toBe(MAX_BUCKETS);
    expect(buckets.take('k0', later).allowed).toBe(true);
    expect(buckets.take('k1', later).allowed).toBe(false);
    // Whatever arrives, the map never grows past the cap.
    for (let i = 0; i < 3 * MAX_BUCKETS; i += 1) buckets.take(`flood${i}`, later);
    expect(buckets.size).toBe(MAX_BUCKETS);
  });

  it('answers 429 with Retry-After and the sealed error once a key’s burst is spent, per key, and never charges a key for someone else’s guesses', async () => {
    const migrator = connectMigrator();
    let now = 0;
    const h = harness({ rateLimit: { burst: 2, perSecond: 1 }, clock: () => now });
    try {
      await wipeLedger(migrator);
      resetAuthCaches();
      const boot = await bootstrapTenant(h.database.db);
      const partner = '198.51.100.4';
      const api = client(h, boot.plainKey);
      const first = await api.get('/v1/users/usr_x', { address: partner });
      expect(first.status).toBe(400);
      expect(first.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('2');
      expect(first.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('1');
      await api.get('/v1/users/usr_x', { address: partner });
      const limited = await api.get('/v1/users/usr_x', { address: partner });
      expect(limited.status).toBe(429);
      expect(limited.headers.get(RETRY_AFTER_HEADER)).toBe('1');
      expect(limited.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('0');
      expect(limited.error).toMatchObject({ type: 'rate_limited', code: 'too_many_requests', detail: { retryAfterSeconds: 1, limit: 2 } });
      // Another key has its own bucket.
      expect((await client(h, boot.operatorKey).get('/v1/users/usr_x', { address: partner })).status).toBe(400);

      // A stranger who knows the key's visible prefix spends their own address's bucket, not the key's:
      // the genuine key is back to one token a second later, whatever the stranger sent.
      now = 1_000;
      const stranger = '203.0.113.7';
      const lookalike = client(h, `${boot.plainKey.slice(0, 19)}${'Q'.repeat(13)}`);
      for (let i = 0; i < 5; i += 1) {
        const guess = await lookalike.get('/v1/users/usr_x', { address: stranger });
        expect(guess.status, `guess ${i}`).toBe(i < 2 ? 401 : 429);
        if (i >= 2) expect(guess.error).toMatchObject({ type: 'rate_limited', code: 'too_many_requests' });
      }
      const write = await api.post('/v1/users', { externalId: 'u1' }, { idempotencyKey: 'rl-1', address: partner });
      expect(write.status).toBe(201);
      const again = await api.post('/v1/users', { externalId: 'u2' }, { idempotencyKey: 'rl-2', address: partner });
      expect(again.status).toBe(429);
      expect(await h.database.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'rl-2'))).toEqual([]);
      expect(await h.database.db.select().from(idempotencyReservations).where(eq(idempotencyReservations.key, 'rl-2'))).toEqual([]);
      expect(again.headers.get(IDEMPOTENCY_KEY_HEADER)).toBeNull();
      // The stranger's address is refused before any key is looked at, even a genuine one.
      expect((await client(h, boot.operatorKey).get('/v1/users/usr_x', { address: stranger })).status).toBe(429);

      // Requests that authenticate cost their address nothing: after the operator key's own bucket
      // is spent from a fresh address, that address still has its full allowance for failures.
      now = 3_000;
      const office = '192.0.2.10';
      const operator = client(h, boot.operatorKey);
      expect((await operator.get('/v1/users/usr_x', { address: office })).status).toBe(400);
      expect((await operator.get('/v1/users/usr_x', { address: office })).status).toBe(400);
      expect((await operator.get('/v1/users/usr_x', { address: office })).status).toBe(429);
      const anonymous = client(h, undefined);
      expect((await anonymous.get('/v1/users/usr_x', { address: office })).status).toBe(401);
      expect((await anonymous.get('/v1/users/usr_x', { address: office })).status).toBe(401);
      expect((await anonymous.get('/v1/users/usr_x', { address: office })).status).toBe(429);
    } finally {
      await wipeLedger(migrator);
      await migrator.close();
      await h.close();
    }
  });
});
