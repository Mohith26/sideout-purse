import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ApiKeyResource, ConsoleDeliveryResource, ConsoleEndpointResource, TenantDetailResource, TenantResource } from '@purse/types';

import { authenticateApiKey, resetAuthCaches } from '../../src/auth';
import { auditLog, webhookDeliveries, webhookEndpoints } from '../../src/db/schema';
import { addOrigin } from '../../src/embed/origins';
import { emitEvent, WebhookDispatcher } from '../../src/webhooks';
import { connectMigrator, harness, TEST_WEBHOOK_POLICY, type TestHarness } from '../helpers';
import { bootstrapTenant, client } from '../http/client';
import { createTenant, key, wipeLedger } from '../ledger/fixtures';
import { consoleClient } from './client';

/**
 * Tenants, API keys and webhooks from the console (spec 4.10): the list with counts, one
 * tenant with its origins, suspend and reinstate (admin, audited, keys stop working at
 * once), keys listed with prefix and last use and never a hash, created with the
 * plaintext shown once and replayed without it, revoked with an audit row; endpoints and
 * the delivery log with replay.
 */
describe('console tenants, keys and webhooks', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;

  beforeAll(() => {
    owner = connectMigrator();
    h = harness();
  });
  beforeEach(async () => {
    await wipeLedger(owner);
    resetAuthCaches();
  });
  afterAll(async () => {
    await wipeLedger(owner);
    await h.close();
    await owner.close();
  });

  it('lists tenants with counts and shows one with its origins; a stranger gets 401', async () => {
    const boot = await bootstrapTenant(h.database.db);
    const other = await createTenant(h.database.db, 'Other Partner');
    await addOrigin(h.database.db, { tenantId: boot.tenantId, origin: 'https://sideout.example' });
    const { api } = await consoleClient(h, owner.db, 'operator');
    const list = await api.get<{ tenants: TenantResource[] }>('/console/tenants');
    expect(list.status).toBe(200);
    expect(list.data?.tenants.map((each) => each.id).sort()).toEqual([boot.tenantId, other].sort());
    const mine = list.data?.tenants.find((each) => each.id === boot.tenantId);
    expect(mine?.counts).toEqual({ apiKeys: 3, users: 0, contests: 0, webhookEndpoints: 0 });

    const detail = await api.get<TenantDetailResource>(`/console/tenants/${boot.tenantId}`);
    expect(detail.data).toMatchObject({ id: boot.tenantId, status: 'active', origins: ['https://sideout.example'] });
    expect((await api.get(`/console/tenants/tnt_${'0'.repeat(8)}-0000-7000-8000-000000000000`)).status).toBe(404);
    expect((await api.get('/console/tenants/not-an-id')).status).toBe(400);
    expect((await client(h, undefined).get('/console/tenants')).status).toBe(401);
  });

  it('suspends and reinstates a tenant as admin, audited, and a suspended tenant’s keys stop authenticating', async () => {
    const boot = await bootstrapTenant(h.database.db);
    const operator = await consoleClient(h, owner.db, 'operator');
    const refused = await operator.api.post(`/console/tenants/${boot.tenantId}/status`, { status: 'suspended' });
    expect(refused.status).toBe(403);
    expect(refused.error?.code).toBe('admin_required');

    const admin = await consoleClient(h, owner.db, 'admin');
    const suspended = await admin.api.post<TenantResource>(`/console/tenants/${boot.tenantId}/status`, { status: 'suspended', reason: 'unpaid invoice' });
    expect(suspended.status).toBe(200);
    expect(suspended.data?.status).toBe('suspended');
    await expect(authenticateApiKey(h.database.db, boot.operatorKey)).rejects.toMatchObject({ code: 'tenant_suspended' });
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'tenant.suspended'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'operator', actorRef: admin.session.operator.id, subject: boot.tenantId, after: { status: 'suspended', reason: 'unpaid invoice' } });

    const back = await admin.api.post<TenantResource>(`/console/tenants/${boot.tenantId}/status`, { status: 'active' });
    expect(back.data?.status).toBe('active');
    await expect(authenticateApiKey(h.database.db, boot.operatorKey)).resolves.toBeDefined();
    // Setting the status a tenant already has changes nothing and audits nothing.
    await admin.api.post(`/console/tenants/${boot.tenantId}/status`, { status: 'active' });
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.action, 'tenant.reinstated'))).toHaveLength(1);
  });

  it('lists keys without hashes, creates one revealed once and replayed without it, and revokes it', async () => {
    const boot = await bootstrapTenant(h.database.db);
    await authenticateApiKey(h.database.db, boot.plainKey);
    const admin = await consoleClient(h, owner.db, 'admin');
    const list = await admin.api.get<{ apiKeys: ApiKeyResource[] }>(`/console/tenants/${boot.tenantId}/api-keys`);
    expect(list.data?.apiKeys).toHaveLength(3);
    const plain = list.data?.apiKeys.find((each) => each.id === boot.keyIds.plain);
    expect(plain).toMatchObject({ kind: 'secret', environment: 'sandbox', scopes: [], label: 'plain', plaintext: null, revokedAt: null });
    expect(plain?.keyPrefix).toMatch(/^sk_sandbox_[A-Za-z0-9]{8}$/);
    expect(plain?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(list.raw)).not.toContain('argon2');

    const idempotencyKey = key('console-key');
    const created = await admin.api.post<ApiKeyResource>(`/console/tenants/${boot.tenantId}/api-keys`, { kind: 'secret', environment: 'live', scopes: ['operator'], label: 'ops' }, { idempotencyKey });
    expect(created.status).toBe(201);
    expect(created.data?.plaintext).toMatch(/^sk_live_[A-Za-z0-9]{32}$/);
    expect(created.data?.scopes).toEqual(['operator']);
    const replay = await admin.api.post<ApiKeyResource>(`/console/tenants/${boot.tenantId}/api-keys`, { kind: 'secret', environment: 'live', scopes: ['operator'], label: 'ops' }, { idempotencyKey });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(replay.data?.id).toBe(created.data?.id);
    expect(replay.data?.plaintext).toBeNull();
    // The new key works against v1 as an operator.
    const asPartner = client(h, created.data?.plaintext ?? '');
    expect((await asPartner.get('/v1/webhooks/endpoints')).status).toBe(200);

    const operator = await consoleClient(h, owner.db, 'operator');
    expect((await operator.api.post(`/console/tenants/${boot.tenantId}/api-keys/${created.data?.id}/revoke`, {})).status).toBe(403);
    const missingKey = await admin.api.post(`/console/tenants/${boot.tenantId}/api-keys/${created.data?.id}/revoke`, {}, { idempotencyKey: null });
    expect(missingKey.status).toBe(400);
    expect(missingKey.error?.code).toBe('missing_idempotency_key');
    const revoked = await admin.api.post<ApiKeyResource>(`/console/tenants/${boot.tenantId}/api-keys/${created.data?.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.data?.revokedAt).not.toBeNull();
    expect((await asPartner.get('/v1/webhooks/endpoints')).status).toBe(401);
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'api_key.revoked'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'operator', actorRef: admin.session.operator.id });
    // A key of another tenant is not reachable through this one.
    const other = await createTenant(h.database.db);
    expect((await admin.api.post(`/console/tenants/${other}/api-keys/${boot.keyIds.plain}/revoke`, {})).status).toBe(400);
  });

  it('manages endpoints and the delivery log, and replays a delivery as a new one', async () => {
    const boot = await bootstrapTenant(h.database.db);
    const { api, session } = await consoleClient(h, owner.db, 'operator');
    const base = `/console/tenants/${boot.tenantId}/webhooks`;
    const idempotencyKey = key('console-endpoint');
    const created = await api.post<ConsoleEndpointResource>(`${base}/endpoints`, { url: 'https://receiver.example/hooks', subscribedEvents: ['contest.opened'], description: 'ops receiver' }, { idempotencyKey });
    expect(created.status).toBe(201);
    expect(created.data?.secret).toMatch(/^whsec_/);
    const replay = await api.post<ConsoleEndpointResource>(`${base}/endpoints`, { url: 'https://receiver.example/hooks', subscribedEvents: ['contest.opened'], description: 'ops receiver' }, { idempotencyKey });
    expect(replay.data?.secret).toBeNull();
    const endpointId = created.data?.id ?? '';
    const listed = await api.get<{ endpoints: ConsoleEndpointResource[] }>(`${base}/endpoints`);
    expect(listed.data?.endpoints.map((each) => each.id)).toEqual([endpointId]);
    const rotated = await api.post<ConsoleEndpointResource>(`${base}/endpoints/${endpointId}/rotate`, {});
    expect(rotated.data?.secret).toMatch(/^whsec_/);
    expect(rotated.data?.secret).not.toBe(created.data?.secret);
    // Two deliveries queued by the platform; the log shows them per endpoint and across every tenant.
    const event = { kind: 'tournament', asset: 'POINTS', state: 'open', previousState: 'draft', settledAt: null } as const;
    await emitEvent(h.database.db, { tenantId: boot.tenantId, type: 'contest.opened', data: { contestId: 'cnt_x', externalId: 'x', ...event } });
    await emitEvent(h.database.db, { tenantId: boot.tenantId, type: 'contest.opened', data: { contestId: 'cnt_y', externalId: 'y', ...event } });
    const disabled = await api.send<ConsoleEndpointResource>('PATCH', `${base}/endpoints/${endpointId}`, { status: 'disabled' });
    expect(disabled.data?.status).toBe('disabled');
    const log = await api.get<{ deliveries: ConsoleDeliveryResource[] }>(`${base}/endpoints/${endpointId}/deliveries?status=pending`);
    expect(log.data?.deliveries).toHaveLength(2);
    expect(log.data?.deliveries[0]).toMatchObject({ endpointUrl: 'https://receiver.example/hooks', tenantId: boot.tenantId, status: 'pending', attempts: [] });
    const global = await api.get<{ deliveries: ConsoleDeliveryResource[] }>('/console/webhooks/deliveries?status=pending');
    expect(global.data?.deliveries.map((each) => each.id).sort()).toEqual(log.data?.deliveries.map((each) => each.id).sort());
    expect((await api.get('/console/webhooks/deliveries?status=bogus')).status).toBe(400);

    const deliveryId = log.data?.deliveries[0]?.id ?? '';
    const one = await api.get<ConsoleDeliveryResource>(`${base}/deliveries/${deliveryId}`);
    expect(one.data?.id).toBe(deliveryId);
    // A disabled endpoint cannot be replayed to; enabled, the replay is a new delivery of the same event.
    const refused = await api.post(`${base}/deliveries/${deliveryId}/replay`, {});
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('endpoint_disabled');
    await api.send('PATCH', `${base}/endpoints/${endpointId}`, { status: 'enabled' });
    const replayKey = key('replay');
    const replayed = await api.post<ConsoleDeliveryResource>(`${base}/deliveries/${deliveryId}/replay`, {}, { idempotencyKey: replayKey });
    expect(replayed.status).toBe(201);
    expect(replayed.data).toMatchObject({ replayOf: deliveryId, eventId: one.data?.eventId, endpointId });
    const again = await api.post<ConsoleDeliveryResource>(`${base}/deliveries/${deliveryId}/replay`, {}, { idempotencyKey: replayKey });
    expect(again.data?.id).toBe(replayed.data?.id);
    expect(await owner.db.select().from(webhookDeliveries)).toHaveLength(3);
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'webhook_delivery.replayed'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'operator', actorRef: session.operator.id });
    // Another tenant's delivery is not reachable through this tenant.
    const other = await createTenant(h.database.db);
    expect((await api.get(`/console/tenants/${other}/webhooks/deliveries/${deliveryId}`)).status).toBe(403);
  });

  it('refuses a private webhook destination on the console path too, and shows a dispatch refusal in the delivery log', async () => {
    const boot = await bootstrapTenant(h.database.db);
    const { api } = await consoleClient(h, owner.db, 'operator');
    const base = `/console/tenants/${boot.tenantId}/webhooks`;
    for (const [url, reason] of [
      ['https://169.254.169.254/latest/meta-data/', 'link_local_address'],
      ['https://10.0.0.1/hooks', 'private_address'],
      ['https://0xa000001/hooks', 'private_address'], // 10.0.0.1 in hexadecimal
      ['https://user:pw@ops.example/hooks', 'credentials_present'],
    ] as const) {
      const response = await api.post(`${base}/endpoints`, { url, subscribedEvents: ['contest.opened'] }, { idempotencyKey: key('console-refusal') });
      expect(response.status, url).toBe(400);
      expect(response.error, url).toMatchObject({ type: 'invalid_request', code: 'url_not_allowed', detail: { reason } });
    }

    // An endpoint stored before this check existed still cannot deliver: the dispatcher
    // refuses it and the attempt says why, which is what the console's delivery log renders.
    const created = await api.post<ConsoleEndpointResource>(`${base}/endpoints`, { url: 'https://ops.example/hooks', subscribedEvents: ['contest.opened'] }, { idempotencyKey: key('console-endpoint') });
    const endpointId = created.data?.id ?? '';
    await owner.db.update(webhookEndpoints).set({ url: 'http://169.254.169.254/latest/meta-data/' }).where(eq(webhookEndpoints.id, endpointId));
    await emitEvent(h.database.db, {
      tenantId: boot.tenantId,
      type: 'contest.opened',
      data: { contestId: 'cnt_z', externalId: 'z', kind: 'tournament', asset: 'POINTS', state: 'open', previousState: 'draft', settledAt: null },
    });
    const worker = new WebhookDispatcher({ db: h.database.db, keys: h.keys, logger: h.logger, policy: TEST_WEBHOOK_POLICY, instanceId: 'console-refusal', deliveryTimeoutMs: 1000 });
    expect((await worker.runOnce()).retried).toBe(1);
    const log = await api.get<{ deliveries: ConsoleDeliveryResource[] }>(`${base}/endpoints/${endpointId}/deliveries`);
    const attempt = log.data?.deliveries[0]?.attempts[0];
    expect(attempt?.responseStatus).toBeNull();
    expect(attempt?.error).toContain('destination_refused');
    expect(attempt?.error).toContain('link_local_address');
  });
});
