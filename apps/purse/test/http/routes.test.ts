import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContestResource, UserResource } from '@purse/types';
import { newId } from '@repo/ids';

import { resetAuthCaches } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { wipeLedger } from '../ledger/fixtures';
import { bootstrapTenant, client, type Bootstrap } from './client';

/**
 * Every v1 route, three ways: without a key (401), with a body that fails validation
 * (400, nothing changed), and the happy path is `test/contract/contract.test.ts`. A route
 * missing from the table below is a route without these guarantees, so the table also
 * checks itself against what the app actually mounts. The embed's publishable-key routes
 * (`/v1/embed/*` but `tokens`) are a separate stack with their own table in
 * `test/embed/routes.test.ts`.
 */
type Route = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; invalidBody?: unknown };

const endpointId = newId('whe');
const deliveryId = newId('whd');

describe('every v1 route', () => {
  let migrator: Database;
  let h: TestHarness;
  let boot: Bootstrap;
  let userId = '';
  let contestId = '';
  beforeAll(async () => {
    migrator = connectMigrator();
    h = harness();
    await wipeLedger(migrator);
    resetAuthCaches();
    boot = await bootstrapTenant(h.database.db);
    const api = client(h, boot.operatorKey);
    userId = (await api.post<UserResource>('/v1/users', { externalId: 'u1', displayName: 'U', dateOfBirth: '1990-01-01' })).data?.id ?? '';
    contestId = (await api.post<ContestResource>('/v1/contests', { externalId: 'c1', kind: 'tournament', title: 'T', asset: 'POINTS', entryAmount: '10', prizeStructure: { type: 'winner_take_all' } })).data?.id ?? '';
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await h.close();
  });

  const routes = (): Route[] => [
    { method: 'POST', path: '/v1/users', invalidBody: { externalId: 42 } },
    { method: 'GET', path: `/v1/users/${userId}` },
    { method: 'POST', path: `/v1/users/${userId}/verification`, invalidBody: { flow: 'identity' } },
    { method: 'GET', path: `/v1/users/${userId}/wallet` },
    { method: 'POST', path: `/v1/users/${userId}/credits`, invalidBody: { asset: 'USD', amount: '10' } },
    { method: 'POST', path: '/v1/contests', invalidBody: { externalId: 'c2', kind: 'raffle' } },
    { method: 'GET', path: `/v1/contests/${contestId}` },
    { method: 'POST', path: `/v1/contests/${contestId}/open`, invalidBody: { reason: '' } },
    { method: 'POST', path: `/v1/contests/${contestId}/lock`, invalidBody: { force: true } },
    { method: 'POST', path: `/v1/contests/${contestId}/start`, invalidBody: { reason: 5 } },
    { method: 'POST', path: `/v1/contests/${contestId}/finish`, invalidBody: { reason: 5 } },
    { method: 'POST', path: `/v1/contests/${contestId}/entries`, invalidBody: { userId: 'someone', seed: 0 } },
    { method: 'DELETE', path: `/v1/contests/${contestId}/entries/${userId}`, invalidBody: 'not json' },
    { method: 'POST', path: `/v1/contests/${contestId}/scores`, invalidBody: { scores: [] } },
    { method: 'GET', path: `/v1/contests/${contestId}/preview` },
    { method: 'POST', path: `/v1/contests/${contestId}/close`, invalidBody: { payoutHash: 'short' } },
    { method: 'POST', path: `/v1/contests/${contestId}/void`, invalidBody: { reason: 'x'.repeat(501) } },
    { method: 'GET', path: `/v1/contests/${contestId}/results` },
    { method: 'POST', path: '/v1/embed/tokens', invalidBody: { userId, flow: 'checkout' } },
    { method: 'POST', path: '/v1/webhooks/endpoints', invalidBody: { url: 'https://example.test/hook', subscribedEvents: [] } },
    { method: 'GET', path: '/v1/webhooks/endpoints' },
    { method: 'GET', path: `/v1/webhooks/endpoints/${endpointId}` },
    { method: 'PATCH', path: `/v1/webhooks/endpoints/${endpointId}`, invalidBody: { status: 'paused' } },
    { method: 'POST', path: `/v1/webhooks/endpoints/${endpointId}/rotate`, invalidBody: { force: true } },
    { method: 'GET', path: `/v1/webhooks/endpoints/${endpointId}/deliveries` },
    { method: 'GET', path: `/v1/webhooks/deliveries/${deliveryId}` },
    { method: 'POST', path: `/v1/webhooks/deliveries/${deliveryId}/replay`, invalidBody: { attempt: 1 } },
    { method: 'GET', path: '/v1/origins' },
    { method: 'POST', path: '/v1/origins', invalidBody: { origin: 5 } },
    { method: 'POST', path: '/v1/origins/revoke', invalidBody: { origins: [] } },
  ];

  it('is listed here', () => {
    const mounted = h.app.routes
      .filter((route) => route.path.startsWith('/v1/') && !route.path.endsWith('*') && route.method !== 'ALL' && route.method !== 'OPTIONS')
      .filter((route) => !route.path.startsWith('/v1/embed/') || route.path === '/v1/embed/tokens')
      .map((route) => `${route.method} ${route.path}`);
    const expected = routes().map(
      (route) => `${route.method} ${route.path.replace(userId, ':userId').replace(contestId, ':id').replace(endpointId, ':id').replace(deliveryId, ':id').replace('/users/:userId', '/users/:id')}`,
    );
    for (const each of new Set(mounted)) {
      if (each.includes('/health') || each.includes('/status') || each.includes('/internal/')) continue;
      expect(expected, `${each} is covered by this table`).toContain(each);
    }
  });

  it('refuses every route without a key', async () => {
    const anonymous = client(h, undefined);
    for (const route of routes()) {
      const response = await anonymous.send(route.method, route.path, route.method === 'GET' ? undefined : {});
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(response.error, `${route.method} ${route.path}`).toMatchObject({ type: 'authentication_error', code: 'missing_api_key' });
    }
  });

  it('refuses every mutation with a body that fails validation, before anything is written', async () => {
    const api = client(h, boot.operatorKey);
    const before = await h.database.sql`select count(*)::int as n from audit_log`;
    for (const route of routes()) {
      if (route.method === 'GET') continue;
      const response =
        typeof route.invalidBody === 'string'
          ? await api.send(route.method, route.path, undefined, { rawBody: route.invalidBody })
          : await api.send(route.method, route.path, route.invalidBody);
      expect(response.status, `${route.method} ${route.path}`).toBe(400);
      expect(response.error?.type, `${route.method} ${route.path}`).toBe('invalid_request');
      expect(['validation_failed', 'invalid_input', 'invalid_json', 'invalid_prize_structure']).toContain(response.error?.code);
    }
    const after = await h.database.sql`select count(*)::int as n from audit_log`;
    expect(after[0]?.['n']).toBe(before[0]?.['n']);
  });
});
