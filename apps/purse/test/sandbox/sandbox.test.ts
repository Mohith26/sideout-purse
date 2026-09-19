import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContestResource, UserResource, SandboxKeysResource } from '@purse/types';
import type { Id } from '@repo/ids';

import { authenticateApiKey, createApiKey, resetAuthCaches, revokeApiKey } from '../../src/auth/api-keys';
import type { Database } from '../../src/db/client';
import { apiKeys, auditLog, sandboxLeases, tenantOrigins, tenants } from '../../src/db/schema';
import { loadEnv } from '../../src/env';
import { SYSTEM_ACTOR } from '../../src/ledger/audit';
import { purgeExpired } from '../../src/maintenance/purge';
import { mintSandbox, SANDBOX_TTL_MS } from '../../src/sandbox/mint';
import { setTenantStatus } from '../../src/tenants';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { bootstrapTenant, client } from '../http/client';
import { wipeLedger } from '../ledger/fixtures';

describe('self-serve sandboxes', () => {
  let owner: Database;
  let h: TestHarness;
  const now = new Date();
  beforeAll(() => { owner = connectMigrator(); });
  beforeEach(async () => {
    await wipeLedger(owner);
    resetAuthCaches();
    h = harness({ clock: () => now.getTime(), max: 6 });
  });
  afterAll(async () => { await wipeLedger(owner); await owner.close(); });
  // Each case closes its own pool, including a failing assertion.
  async function withHarness(run: () => Promise<void>) { try { await run(); } finally { await h.close(); } }
  const mint = (requestKey = 'mint-1', address = '203.0.113.1') => client(h, undefined).post<SandboxKeysResource>('/v1/sandbox/keys', {}, { idempotencyKey: requestKey, address });

  it('mints a fresh isolated tenant and returns two hashed, expiring keys only once', () => withHarness(async () => {
    const first = await client(h, undefined).post<SandboxKeysResource>('/v1/sandbox/keys', {}, { idempotencyKey: 'mint-1', address: '203.0.113.1', headers: { Origin: 'http://localhost' } });
    expect(first.headers.get('access-control-allow-origin')).toBe('http://localhost');
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.data?.secretKey).toMatch(/^sk_sandbox_/);
    expect(first.data?.publishableKey).toMatch(/^pk_sandbox_/);
    expect(first.data).toMatchObject({ expiresAt: new Date(now.getTime() + SANDBOX_TTL_MS).toISOString(), replayed: false });
    const again = await mint();
    expect(again.data).toEqual({ ...first.data, secretKey: null, publishableKey: null, replayed: true });
    const rows = await h.database.db.select().from(apiKeys);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(first.data?.secretKey);
    expect(rows.every((row) => row.keyHash.startsWith('$argon2id$') && row.expiresAt?.getTime() === now.getTime() + SANDBOX_TTL_MS)).toBe(true);
    expect(await h.database.db.select().from(sandboxLeases)).toMatchObject([{ address: '203.0.113.1' }]);
    expect(await h.database.db.select().from(tenantOrigins)).toMatchObject([{ origin: 'http://localhost' }]);
    expect(h.lines.some((line) => JSON.stringify(line).includes(first.data?.secretKey ?? 'missing'))).toBe(false);
  }));

  it('enforces the persistent three-per-address bound under concurrent minting', () => withHarness(async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => mintSandbox(h.database.db, { address: '203.0.113.2', requestKey: `concurrent-${i}`, origin: 'http://localhost', now })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    expect(await h.database.db.select().from(tenants)).toHaveLength(3);
  }));

  it('limits minting by address and process, with Retry-After', () => withHarness(async () => {
    for (let i = 0; i < 3; i++) expect((await mint(`address-${i}`)).status).toBe(201);
    const refused = await mint('address-4');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('3600');
    for (let i = 0; i < 6; i++) expect((await mint(`global-${i}`, `203.0.113.${i + 10}`)).status).toBe(201);
    const global = await mint('global-last', '203.0.113.99');
    expect(global.status).toBe(429);
    expect(global.headers.get('retry-after')).toBe('60');
  }));

  it('requires idempotency, rejects extra fields and refuses foreign origins', () => withHarness(async () => {
    expect((await client(h, undefined).post('/v1/sandbox/keys', {}, { idempotencyKey: null })).status).toBe(400);
    expect((await client(h, undefined).post('/v1/sandbox/keys', { tenantId: 'seeded' })).status).toBe(400);
    const cross = await client(h, undefined).post('/v1/sandbox/keys', {}, { headers: { Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect(cross.headers.get('access-control-allow-origin')).toBeNull();
    expect(await h.database.db.select().from(tenants)).toHaveLength(0);
  }));

  it('expires both key kinds even when the verification cache is warm, and honors revocation', () => withHarness(async () => {
    const minted = (await mint()).data;
    if (!minted?.secretKey || !minted.publishableKey) throw new Error('mint failed');
    const auth = await authenticateApiKey(h.database.db, minted.secretKey, { now });
    await authenticateApiKey(h.database.db, minted.publishableKey, { now });
    const expiry = new Date(minted.expiresAt);
    for (const token of [minted.secretKey, minted.publishableKey]) await authenticateApiKey(h.database.db, token, { now: new Date(expiry.getTime() - 1) });
    for (const token of [minted.secretKey, minted.publishableKey]) await expect(authenticateApiKey(h.database.db, token, { now: expiry })).rejects.toMatchObject({ code: 'api_key_expired' });
    const extra = await createApiKey(h.database.db, { tenantId: minted.tenantId as Id<'tnt'>, kind: 'secret', environment: 'sandbox' });
    await expect(authenticateApiKey(h.database.db, extra.plaintext, { now: expiry })).rejects.toMatchObject({ code: 'api_key_expired' });
    await revokeApiKey(h.database.db, { tenantId: minted.tenantId as Id<'tnt'>, keyId: auth.key.id, actor: SYSTEM_ACTOR });
    await expect(authenticateApiKey(h.database.db, minted.secretKey, { now })).rejects.toMatchObject({ code: 'api_key_revoked' });
    // Expiry is enforced by HTTP authentication too, including a key created by a console.
    const expired = await createApiKey(h.database.db, { tenantId: minted.tenantId as Id<'tnt'>, kind: 'secret', environment: 'sandbox', expiresAt: new Date(0) });
    expect((await client(h, expired.plaintext).get('/v1/origins')).error?.code).toBe('api_key_expired');
  }));

  it('retires expired sandboxes, preserves append-only history and never retires managed tenants', () => withHarness(async () => {
    const managed = await bootstrapTenant(h.database.db);
    const minted = (await mint()).data;
    if (!minted?.secretKey) throw new Error('mint failed');
    await client(h, minted.secretKey).post('/v1/users', { externalId: 'retained' });
    const before = await h.database.db.select().from(auditLog).where(eq(auditLog.tenantId, minted.tenantId));
    const result = await purgeExpired(owner.db, new Date(minted.expiresAt));
    expect(result.sandboxesRetired).toBe(1);
    expect((await purgeExpired(owner.db, new Date(minted.expiresAt))).sandboxesRetired).toBe(0);
    const [retired] = await h.database.db.select().from(tenants).where(eq(tenants.id, minted.tenantId));
    expect(retired?.status).toBe('retired');
    const retiredKeys = await h.database.db.select().from(apiKeys).where(eq(apiKeys.tenantId, minted.tenantId));
    expect(retiredKeys.every((row) => row.revokedAt !== null)).toBe(true);
    const origins = await h.database.db.select().from(tenantOrigins).where(eq(tenantOrigins.tenantId, minted.tenantId));
    expect(origins.every((row) => row.revokedAt !== null)).toBe(true);
    await expect(setTenantStatus(h.database.db, { tenantId: minted.tenantId as Id<'tnt'>, status: 'active', actor: SYSTEM_ACTOR })).rejects.toThrow('cannot be reinstated');
    expect((await h.database.db.select().from(auditLog).where(eq(auditLog.tenantId, minted.tenantId))).length).toBeGreaterThan(before.length);
    expect((await authenticateApiKey(h.database.db, managed.operatorKey)).tenant.status).toBe('active');
    await expect(authenticateApiKey(h.database.db, minted.secretKey)).rejects.toMatchObject({ code: 'api_key_revoked' });
  }));

  it('cannot read another tenant’s user or contest; outbound webhook mutations are refused', () => withHarness(async () => {
    const managed = await bootstrapTenant(h.database.db);
    const theirClient = client(h, managed.operatorKey);
    const user = await theirClient.post<UserResource>('/v1/users', { externalId: 'demo-user' });
    const contest = await theirClient.post<ContestResource>('/v1/contests', { externalId: 'demo-contest', title: 'Demo', kind: 'head_to_head', asset: 'POINTS', entryAmount: '10', prizeStructure: { type: 'winner_take_all' } });
    expect(contest.status).toBe(201);
    const minted = (await mint()).data;
    if (!minted?.secretKey) throw new Error('mint failed');
    const sandbox = client(h, minted.secretKey);
    expect((await sandbox.get(`/v1/users/${user.data?.id ?? ''}`)).status).toBe(403);
    expect((await sandbox.get(`/v1/contests/${contest.data?.id ?? ''}`)).status).toBe(403);
    const refused = await sandbox.post('/v1/webhooks/endpoints', { url: 'http://localhost:4000', subscribedEvents: ['contest.opened'] });
    expect(refused.error).toMatchObject({ type: 'permission_error', code: 'sandbox_webhooks_unavailable' });
    const own = await sandbox.post<UserResource>('/v1/users', { externalId: 'mine' });
    expect((await sandbox.post(`/v1/users/${own.data?.id ?? ''}/credits`, { asset: 'POINTS', amount: '1000' })).status).toBe(201);
    expect(await h.database.db.select().from(apiKeys).where(and(eq(apiKeys.tenantId, minted.tenantId), eq(apiKeys.kind, 'secret')))).toMatchObject([{ scopes: ['operator'] }]);
  }));

  it('reports the switch in health and prevents disabled minting', () => withHarness(async () => {
    const disabled = harness({ sandboxSelfServe: false });
    try {
      expect((await client(disabled, undefined).post('/v1/sandbox/keys', {})).error?.code).toBe('sandbox_disabled');
      expect((await client(disabled, undefined).get<{ sandboxSelfServe: boolean }>('/health')).data?.sandboxSelfServe).toBe(false);
    } finally { await disabled.close(); }
    const development = { PURSE_DATABASE_URL: 'postgres://unused/unused' };
    expect(loadEnv(development).sandboxSelfServe).toBe(true);
    const production = { ...development, NODE_ENV: 'production', PURSE_SECRET_KEY: 'x'.repeat(32) };
    expect(loadEnv(production).sandboxSelfServe).toBe(false);
    expect(loadEnv({ ...production, SANDBOX_SELF_SERVE: 'true' }).sandboxSelfServe).toBe(true);
    expect(loadEnv({ ...development, SANDBOX_SELF_SERVE: 'false' }).sandboxSelfServe).toBe(false);
  }));
});
