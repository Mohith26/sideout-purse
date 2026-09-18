import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type Id } from '@repo/ids';

import { authenticateApiKey, createApiKey, isAuthError, keyPrefixOf, listApiKeys, resetAuthCaches, revokeApiKey } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { apiKeys, auditLog, tenants } from '../../src/db/schema';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { createTenant, wipeLedger } from '../ledger/fixtures';

/**
 * Spec 4.1 `api_keys`: only an argon2id hash is stored, the plaintext is returned once,
 * lookup is by prefix then hash verification, and a revoked key stops working at once.
 */
describe('API keys', () => {
  let migrator: Database;
  let runtime: Database;
  let tenantId: Id<'tnt'>;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    resetAuthCaches();
    tenantId = await createTenant(runtime.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('mints a prefixed key, stores only its argon2id hash, and shows the plaintext exactly once', async () => {
    const { key, plaintext } = await createApiKey(runtime.db, { tenantId, kind: 'secret', environment: 'sandbox', scopes: ['operator'], label: 'server', actor: { kind: 'operator', ref: 'op_1' } });
    expect(plaintext).toMatch(/^sk_sandbox_[A-Za-z0-9]{32}$/);
    expect(key.keyPrefix).toBe(plaintext.slice(0, 'sk_sandbox_'.length + 8));
    expect(key.keyHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(key.keyHash).not.toContain(plaintext.slice(-32));
    expect(key).toMatchObject({ tenantId, kind: 'secret', environment: 'sandbox', scopes: ['operator'], label: 'server', lastUsedAt: null, revokedAt: null });
    // Nothing but the hash holds the key: not the audit log, not the listing.
    const [audit] = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, key.id));
    expect(JSON.stringify(audit)).not.toContain(plaintext);
    expect(JSON.stringify(audit)).not.toContain(key.keyHash);
    expect(audit).toMatchObject({ action: 'api_key.created', actorKind: 'operator', actorRef: 'op_1' });
    const listed = await listApiKeys(runtime.db, tenantId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('argon2');

    const publishable = await createApiKey(runtime.db, { tenantId, kind: 'publishable', environment: 'live' });
    expect(publishable.plaintext).toMatch(/^pk_live_[A-Za-z0-9]{32}$/);
    expect(publishable.key.scopes).toEqual([]);
    expect(isAuthError(await rejection(createApiKey(runtime.db, { tenantId, kind: 'publishable', environment: 'live', scopes: ['operator'] })), 'invalid_input')).toBe(true);
  });

  it('authenticates by prefix then hash, and refuses garbage, unknown, publishable-as-secret and revoked keys without saying which', async () => {
    const { key, plaintext } = await createApiKey(runtime.db, { tenantId, kind: 'secret', environment: 'sandbox' });
    const auth = await authenticateApiKey(runtime.db, plaintext);
    expect(auth.key.id).toBe(key.id);
    expect(auth.tenant.id).toBe(tenantId);
    expect(auth.actor).toEqual({ kind: 'tenant', ref: key.id });

    const garbage = await rejection(authenticateApiKey(runtime.db, 'sk_sandbox_short'));
    expect(isAuthError(garbage, 'invalid_api_key')).toBe(true);
    // Same prefix, different secret: the hash decides.
    const impostor = `${plaintext.slice(0, -4)}XXXX`;
    const wrong = await rejection(authenticateApiKey(runtime.db, impostor));
    expect(isAuthError(wrong, 'invalid_api_key')).toBe(true);
    expect((wrong as Error).message).toBe('Invalid API key');
    const unknown = await rejection(authenticateApiKey(runtime.db, `sk_live_${'a'.repeat(32)}`));
    expect(isAuthError(unknown, 'invalid_api_key')).toBe(true);
    expect((unknown as Error).message).toBe((wrong as Error).message);

    await revokeApiKey(runtime.db, { tenantId, keyId: key.id, actor: { kind: 'operator', ref: 'op_1' } });
    const revoked = await rejection(authenticateApiKey(runtime.db, plaintext));
    expect(isAuthError(revoked, 'api_key_revoked')).toBe(true);
    // Revoking again is a no-op; un-revoking is impossible for every role; a new secret can never be swapped in.
    expect((await revokeApiKey(runtime.db, { tenantId, keyId: key.id, actor: { kind: 'operator' } })).revokedAt).toEqual((await runtime.db.select().from(apiKeys).where(eq(apiKeys.id, key.id)))[0]?.revokedAt);
    expect(String(await rejection(migrator.sql`update api_keys set revoked_at = null where id = ${key.id}`))).toMatch(/stays revoked/);
    expect(String(await rejection(migrator.sql`update api_keys set key_hash = '$argon2id$other' where id = ${key.id}`))).toMatch(/fixed at creation/);
    expect(String(await rejection(runtime.sql`update api_keys set scopes = '{operator}' where id = ${key.id}`))).toMatch(/permission denied for table api_keys/);
    expect(isAuthError(await rejection(revokeApiKey(runtime.db, { tenantId, keyId: newId('key'), actor: { kind: 'operator' } })), 'api_key_not_found')).toBe(true);
    const other = await createTenant(runtime.db);
    expect(isAuthError(await rejection(revokeApiKey(runtime.db, { tenantId: other, keyId: key.id, actor: { kind: 'operator' } })), 'api_key_not_found')).toBe(true);
  });

  it('a suspended tenant’s keys are refused as a permission error', async () => {
    const { plaintext } = await createApiKey(runtime.db, { tenantId, kind: 'secret', environment: 'live' });
    await runtime.db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenantId));
    expect(isAuthError(await rejection(authenticateApiKey(runtime.db, plaintext)), 'tenant_suspended')).toBe(true);
  });

  it('writes last_used_at at most once a minute per key', async () => {
    const { key, plaintext } = await createApiKey(runtime.db, { tenantId, kind: 'secret', environment: 'sandbox' });
    const t0 = new Date('2026-09-18T12:00:00.000Z');
    await authenticateApiKey(runtime.db, plaintext, { now: t0 });
    await authenticateApiKey(runtime.db, plaintext, { now: new Date(t0.getTime() + 30_000) });
    await authenticateApiKey(runtime.db, plaintext, { now: new Date(t0.getTime() + 59_999) });
    let [row] = await runtime.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row?.lastUsedAt).toEqual(t0);
    await authenticateApiKey(runtime.db, plaintext, { now: new Date(t0.getTime() + 60_000) });
    [row] = await runtime.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row?.lastUsedAt).toEqual(new Date(t0.getTime() + 60_000));
    // Without the in-process memory the database still refuses a premature write.
    resetAuthCaches();
    await authenticateApiKey(runtime.db, plaintext, { now: new Date(t0.getTime() + 90_000) });
    [row] = await runtime.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row?.lastUsedAt).toEqual(new Date(t0.getTime() + 60_000));
  });

  it('the prefix is what a console shows and never enough to authenticate', async () => {
    const { key, plaintext } = await createApiKey(runtime.db, { tenantId, kind: 'secret', environment: 'sandbox' });
    expect(keyPrefixOf(plaintext)).toBe(key.keyPrefix);
    expect(() => keyPrefixOf('nope')).toThrow();
    const padded = `${key.keyPrefix}${'0'.repeat(24)}`;
    expect(isAuthError(await rejection(authenticateApiKey(runtime.db, padded)), 'invalid_api_key')).toBe(true);
    // The database refuses a prefix that does not match the key's kind and environment, or an unhashed key.
    const bad = await rejection(
      migrator.db.insert(apiKeys).values({ id: newId('key'), tenantId, kind: 'secret', environment: 'live', keyPrefix: 'sk_sandbox_AAAAAAAA', keyHash: '$argon2id$x' }),
    );
    expect(String((bad as Error).cause)).toMatch(/api_keys_key_prefix_shape/);
    const plain = await rejection(migrator.db.insert(apiKeys).values({ id: newId('key'), tenantId, kind: 'secret', environment: 'live', keyPrefix: 'sk_live_AAAAAAAA', keyHash: plaintext }));
    expect(String((plain as Error).cause)).toMatch(/api_keys_key_hash_argon2id/);
  });
});
