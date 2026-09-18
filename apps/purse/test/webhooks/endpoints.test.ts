import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContestResource, UserResource, WebhookDeliveryResource, WebhookEndpointResource } from '@purse/types';

import { resetAuthCaches } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { webhookDeliveries, webhookEndpoints } from '../../src/db/schema';
import { endpointSecret } from '../../src/webhooks';
import { connectMigrator, harness, TEST_KEYS, type TestHarness } from '../helpers';
import { bootstrapTenant, client, type Bootstrap } from '../http/client';
import { key, wipeLedger } from '../ledger/fixtures';

/**
 * `/v1/webhooks` and `/v1/origins` over HTTP: the secret shown once and never again,
 * rotation, validation, the delivery log per endpoint, tenant isolation, and the outbox
 * writing a delivery the moment a subscribed event happens through the API.
 */
describe('webhook endpoints and origins over HTTP', () => {
  let migrator: Database;
  let h: TestHarness;
  let boot: Bootstrap;
  beforeAll(async () => {
    migrator = connectMigrator();
    h = harness();
    await wipeLedger(migrator);
    resetAuthCaches();
    boot = await bootstrapTenant(h.database.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await h.close();
  });

  it('creates an endpoint with the secret shown once, lists and reads it without the secret, and updates it', async () => {
    const api = client(h, boot.plainKey);
    const k = key('whe');
    const created = await api.post<WebhookEndpointResource>('/v1/webhooks/endpoints', { url: 'https://sideout.example/hooks/purse', subscribedEvents: ['contest.settled', 'contest.settled', 'user.verification.updated'], description: 'prod' }, { idempotencyKey: k });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ url: 'https://sideout.example/hooks/purse', subscribedEvents: ['contest.settled', 'user.verification.updated'], status: 'enabled', description: 'prod' });
    expect(created.data?.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const id = created.data?.id ?? '';

    // The replay of the creating request carries no secret; nor does any read.
    const replay = await api.post<WebhookEndpointResource>('/v1/webhooks/endpoints', { url: 'https://sideout.example/hooks/purse', subscribedEvents: ['contest.settled', 'contest.settled', 'user.verification.updated'], description: 'prod' }, { idempotencyKey: k });
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(replay.data).toEqual({ ...created.data, secret: null });
    const read = await api.get<WebhookEndpointResource>(`/v1/webhooks/endpoints/${id}`);
    expect(read.data).toEqual({ ...created.data, secret: null });
    const list = await api.get<{ endpoints: WebhookEndpointResource[] }>('/v1/webhooks/endpoints');
    expect(list.data?.endpoints.map((each) => each.id)).toEqual([id]);
    expect(list.data?.endpoints[0]?.secret).toBeNull();

    // What rests in the database is an envelope that opens to the secret shown, never the secret.
    const [row] = await h.database.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    expect(row?.signingSecret.startsWith('enc:v1:')).toBe(true);
    expect(row?.signingSecret).not.toContain('whsec');
    expect(row === undefined ? null : endpointSecret(TEST_KEYS, row)).toBe(created.data?.secret);

    const updated = await api.send<WebhookEndpointResource>('PATCH', `/v1/webhooks/endpoints/${id}`, { status: 'disabled', subscribedEvents: ['wallet.balance.changed'], description: null });
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({ status: 'disabled', subscribedEvents: ['wallet.balance.changed'], description: null, secret: null });

    const rotated = await api.post<WebhookEndpointResource>(`/v1/webhooks/endpoints/${id}/rotate`, {});
    expect(rotated.data?.secret).toMatch(/^whsec_/);
    expect(rotated.data?.secret).not.toBe(created.data?.secret);
    const [after] = await h.database.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    expect(after === undefined ? null : endpointSecret(TEST_KEYS, after)).toBe(rotated.data?.secret);
  });

  it('validates the URL (https only, except loopback), the events and the description', async () => {
    const api = client(h, boot.plainKey);
    const http = await api.post('/v1/webhooks/endpoints', { url: 'http://sideout.example/hooks', subscribedEvents: ['contest.settled'] });
    expect(http.status).toBe(400);
    expect(http.error).toMatchObject({ type: 'invalid_request', code: 'url_not_allowed' });
    const loopback = await api.post<WebhookEndpointResource>('/v1/webhooks/endpoints', { url: 'http://localhost:4300/hooks', subscribedEvents: ['contest.settled'] });
    expect(loopback.status).toBe(201);
    for (const body of [
      { url: 'not a url', subscribedEvents: ['contest.settled'] },
      { url: 'https://x.example', subscribedEvents: [] },
      { url: 'https://x.example', subscribedEvents: ['contest.exploded'] },
      { url: 'https://x.example', subscribedEvents: ['contest.settled'], description: '' },
      { url: 'https://x.example', subscribedEvents: ['contest.settled'], extra: true },
      { url: `https://x.example/${'a'.repeat(2100)}`, subscribedEvents: ['contest.settled'] },
    ]) {
      const response = await api.post('/v1/webhooks/endpoints', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.error?.type).toBe('invalid_request');
    }
    const badPatch = await api.send('PATCH', `/v1/webhooks/endpoints/${loopback.data?.id ?? ''}`, { url: 'ftp://x' });
    expect(badPatch.status).toBe(400);
  });

  it('keeps one tenant’s endpoints and deliveries from another', async () => {
    const mine = client(h, boot.plainKey);
    const created = await mine.post<WebhookEndpointResource>('/v1/webhooks/endpoints', { url: 'https://mine.example/hooks', subscribedEvents: ['contest.opened'] });
    const other = await bootstrapTenant(h.database.db);
    const theirs = client(h, other.plainKey);
    const read = await theirs.get(`/v1/webhooks/endpoints/${created.data?.id ?? ''}`);
    expect(read.status).toBe(403);
    expect(read.error).toMatchObject({ type: 'permission_error', code: 'endpoint_wrong_tenant' });
    expect((await theirs.get<{ endpoints: unknown[] }>('/v1/webhooks/endpoints')).data?.endpoints).toEqual([]);
    const missing = await mine.get(`/v1/webhooks/endpoints/whe_01a0b493-1a5e-7549-afe4-01a4eee87a8d`);
    expect(missing.status).toBe(400);
    expect(missing.error).toMatchObject({ type: 'invalid_request', code: 'endpoint_not_found' });
  });

  it('writes a delivery in the transaction of the API call that raised the event, and serves the log per endpoint', async () => {
    const api = client(h, boot.operatorKey);
    const endpoint = await api.post<WebhookEndpointResource>('/v1/webhooks/endpoints', { url: 'https://log.example/hooks', subscribedEvents: ['contest.opened', 'wallet.balance.changed'] });
    const endpointId = endpoint.data?.id ?? '';
    const user = await api.post<UserResource>('/v1/users', { externalId: 'hooked', displayName: 'H', dateOfBirth: '1990-01-01' });
    const credit = await api.post(`/v1/users/${user.data?.id ?? ''}/credits`, { asset: 'POINTS', amount: '250' });
    expect(credit.status).toBe(201);
    const contest = await api.post<ContestResource>('/v1/contests', { externalId: 'hooked-c', kind: 'tournament', title: 'T', asset: 'POINTS', entryAmount: '10', prizeStructure: { type: 'winner_take_all' } });
    const opened = await api.post(`/v1/contests/${contest.data?.id ?? ''}/open`, {});
    expect(opened.status).toBe(200);
    // Locking is not subscribed: no delivery for it.
    await api.post(`/v1/contests/${contest.data?.id ?? ''}/lock`, {});

    const log = await api.get<{ deliveries: WebhookDeliveryResource[] }>(`/v1/webhooks/endpoints/${endpointId}/deliveries`);
    expect(log.status).toBe(200);
    expect(log.data?.deliveries.map((each) => each.eventType).sort()).toEqual(['contest.opened', 'wallet.balance.changed']);
    expect(log.data?.deliveries.every((each) => each.status === 'pending' && each.attempt === 0 && each.maxAttempts === 8 && each.attempts.length === 0 && each.nextAttemptAt !== null)).toBe(true);
    const [walletDelivery] = await h.database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, 'wallet.balance.changed'));
    expect(walletDelivery?.payload).toMatchObject({ type: 'wallet.balance.changed', data: { userId: user.data?.id, asset: 'POINTS', balance: '250', delta: '250', entryKind: 'issue', contestId: null } });
    const one = await api.get<WebhookDeliveryResource>(`/v1/webhooks/deliveries/${walletDelivery?.id ?? ''}`);
    expect(one.data).toMatchObject({ id: walletDelivery?.id, eventId: walletDelivery?.eventId, attempts: [] });
    const filtered = await api.get<{ deliveries: WebhookDeliveryResource[] }>(`/v1/webhooks/endpoints/${endpointId}/deliveries?status=dead&limit=5`);
    expect(filtered.data?.deliveries).toEqual([]);
    const badQuery = await api.get(`/v1/webhooks/endpoints/${endpointId}/deliveries?status=lost`);
    expect(badQuery.status).toBe(400);

    // A tenant replays its own delivery; the replay names the original and is due now.
    const replay = await api.post<WebhookDeliveryResource>(`/v1/webhooks/deliveries/${walletDelivery?.id ?? ''}/replay`, {});
    expect(replay.status).toBe(201);
    expect(replay.data).toMatchObject({ replayOf: walletDelivery?.id, eventId: walletDelivery?.eventId, status: 'pending', attempt: 0 });
    const other = await bootstrapTenant(h.database.db);
    const foreign = await client(h, other.plainKey).post(`/v1/webhooks/deliveries/${walletDelivery?.id ?? ''}/replay`, {});
    expect(foreign.status).toBe(403);
    expect(foreign.error).toMatchObject({ code: 'delivery_wrong_tenant' });
  });

  it('manages the embed origin allowlist: add, list, revoke, restore, validate', async () => {
    const api = client(h, boot.plainKey);
    expect((await api.get<{ origins: string[] }>('/v1/origins')).data).toEqual({ origins: [] });
    const added = await api.post<{ origin: string; origins: string[] }>('/v1/origins', { origin: 'https://Sideout.Example/' });
    expect(added.status).toBe(201);
    expect(added.data).toEqual({ origin: 'https://sideout.example', origins: ['https://sideout.example'] });
    await api.post('/v1/origins', { origin: 'http://localhost:3000' });
    expect((await api.get<{ origins: string[] }>('/v1/origins')).data?.origins).toEqual(['http://localhost:3000', 'https://sideout.example']);
    for (const origin of ['sideout.example', 'https://sideout.example/app', 'ftp://x.example', 'https://user:pw@x.example', 'https://x.example?q=1']) {
      const response = await api.post('/v1/origins', { origin });
      expect(response.status, origin).toBe(400);
      expect(response.error).toMatchObject({ type: 'invalid_request', code: 'invalid_input' });
    }
    const revoked = await api.post<{ origins: string[] }>('/v1/origins/revoke', { origin: 'https://sideout.example' });
    expect(revoked.data?.origins).toEqual(['http://localhost:3000']);
    // Revoking again, or an origin never listed, is a no-op.
    expect((await api.post<{ origins: string[] }>('/v1/origins/revoke', { origin: 'https://sideout.example' })).data?.origins).toEqual(['http://localhost:3000']);
    expect((await api.post<{ origins: string[] }>('/v1/origins/revoke', { origin: 'https://never.example' })).status).toBe(200);
    const restored = await api.post<{ origins: string[] }>('/v1/origins', { origin: 'https://sideout.example' });
    expect(restored.data?.origins).toEqual(['http://localhost:3000', 'https://sideout.example']);
  });
});
