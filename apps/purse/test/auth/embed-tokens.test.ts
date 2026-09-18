import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '@repo/ids';

import { consumeEmbedToken, EMBED_TOKEN_TTL_MS, hashEmbedToken, isAuthError, issueEmbedToken } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { embedTokens } from '../../src/db/schema';
import { purgeExpired } from '../../src/maintenance/purge';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { createTenant, createUser, wipeLedger } from '../ledger/fixtures';

/**
 * Spec 4.8 rule 5 and acceptance criterion 14: embed tokens are single-use, scoped to one
 * user and one flow, expire in five minutes, and a reused or expired one fails.
 */
describe('embed tokens', () => {
  let migrator: Database;
  let runtime: Database;
  let tenantId: Id<'tnt'>;
  let userId: string;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 12 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    tenantId = await createTenant(runtime.db);
    userId = (await createUser(runtime.db, tenantId)).id;
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('stores only a digest, expires in five minutes, and is consumed exactly once', async () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    const issued = await issueEmbedToken(runtime.db, { tenantId, userId, flow: 'wallet', now });
    expect(issued.row).toMatchObject({ tenantId, userId, flow: 'wallet', tokenHash: hashEmbedToken(issued.token), expiresAt: new Date(now.getTime() + EMBED_TOKEN_TTL_MS), consumedAt: null });
    expect(JSON.stringify(await runtime.db.select().from(embedTokens))).not.toContain(issued.token);

    const consumed = await consumeEmbedToken(runtime.db, { token: issued.token, flow: 'wallet', now: new Date(now.getTime() + 60_000) });
    expect(consumed.id).toBe(issued.row.id);
    expect(isAuthError(await rejection(consumeEmbedToken(runtime.db, { token: issued.token, now })), 'embed_token_used')).toBe(true);

    const stale = await issueEmbedToken(runtime.db, { tenantId, userId, flow: 'identity', now });
    expect(isAuthError(await rejection(consumeEmbedToken(runtime.db, { token: stale.token, now: new Date(now.getTime() + EMBED_TOKEN_TTL_MS) })), 'embed_token_expired')).toBe(true);
    const wrongFlow = await issueEmbedToken(runtime.db, { tenantId, userId, flow: 'identity', now });
    expect(isAuthError(await rejection(consumeEmbedToken(runtime.db, { token: wrongFlow.token, flow: 'rewards', now })), 'embed_token_wrong_flow')).toBe(true);
    expect(isAuthError(await rejection(consumeEmbedToken(runtime.db, { token: 'embt_not-a-real-token', now })), 'embed_token_invalid')).toBe(true);
    expect(isAuthError(await rejection(consumeEmbedToken(runtime.db, { token: `embt_${'A'.repeat(43)}`, now })), 'embed_token_invalid')).toBe(true);
    expect(isAuthError(await rejection(issueEmbedToken(runtime.db, { tenantId, userId, flow: 'identity', ttlMs: EMBED_TOKEN_TTL_MS + 1 })), 'invalid_input')).toBe(true);
  });

  it('twelve frames racing for one token: exactly one succeeds', async () => {
    const issued = await issueEmbedToken(runtime.db, { tenantId, userId, flow: 'entry' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeEmbedToken(runtime.db, { token: issued.token })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected' && isAuthError(result.reason, 'embed_token_used'))).toHaveLength(11);
  });

  it('a consumed token is fixed for every role and purged a day later', async () => {
    const issued = await issueEmbedToken(runtime.db, { tenantId, userId, flow: 'entry' });
    await consumeEmbedToken(runtime.db, { token: issued.token });
    expect(String(await rejection(migrator.sql`update embed_tokens set consumed_at = null where id = ${issued.row.id}`))).toMatch(/already consumed/);
    expect(String(await rejection(migrator.sql`update embed_tokens set expires_at = now() + interval '1 day' where id = ${issued.row.id}`))).toMatch(/fixed at creation/);
    expect(String(await rejection(runtime.sql`update embed_tokens set flow = 'wallet' where id = ${issued.row.id}`))).toMatch(/permission denied for table embed_tokens/);
    expect((await purgeExpired(migrator.db, new Date(Date.now() + 23 * 3_600_000))).embedTokens).toBe(0);
    expect((await purgeExpired(migrator.db, new Date(Date.now() + 25 * 3_600_000))).embedTokens).toBe(1);
    expect(await runtime.db.select().from(embedTokens)).toEqual([]);
  });
});
