import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { API_KEY_ENVIRONMENTS, API_KEY_KINDS, type TenantDetailResource, type TenantResource } from '@purse/types';
import type { Id } from '@repo/ids';

import { createApiKey, listApiKeys, revokeApiKey } from '../../auth';
import { API_KEY_SCOPES, tenants, type Tenant } from '../../db/schema';
import type { DbOrTx } from '../../db/client';
import { activeOrigins } from '../../embed/origins';
import { parseBody } from '../../http/body';
import { ok, okOnce } from '../../http/envelope';
import { listTenants, setTenantStatus } from '../../tenants';
import { param } from '../v1/schemas';
import { requireAdmin } from './auth';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { apiKeyResource, tenantResource } from './serialize';

/**
 * `/console/tenants` (spec 4.10 "tenants, API keys"): the partner list with counts, one
 * partner with its origins, suspend or reinstate (admin), and the keys: list with prefix,
 * environment, scopes and last use; create with the plaintext shown once; revoke. Every
 * mutation under a tenant takes an `Idempotency-Key` and is stored under the tenant's
 * namespace with the console's prefix (`routes/console/index.ts`).
 */
const statusSchema = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(1).max(500).optional() }).strict();

const createKeySchema = z
  .object({
    kind: z.enum(API_KEY_KINDS),
    environment: z.enum(API_KEY_ENVIRONMENTS),
    scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).default([]),
    label: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

const emptySchema = z.object({}).strict();
const keyIdSchema = z.string().regex(/^key_[0-9a-f-]{36}$/, 'must be an API key id (key_...)');

type Counts = TenantResource['counts'];

async function countsFor(db: DbOrTx, tenantIds: readonly string[]): Promise<Map<string, Counts>> {
  const zero = (): Counts => ({ apiKeys: 0, users: 0, contests: 0, webhookEndpoints: 0 });
  const counts = new Map(tenantIds.map((id) => [id, zero()]));
  if (tenantIds.length === 0) return counts;
  // Drizzle renders a column inside a subquery unqualified, so the correlated references are spelled out.
  const rows = await db
    .select({
      id: tenants.id,
      apiKeys: sql<string>`(select count(*) from api_keys k where k.tenant_id = tenants.id and k.revoked_at is null)::text`,
      users: sql<string>`(select count(*) from users u where u.tenant_id = tenants.id)::text`,
      contests: sql<string>`(select count(*) from contests c where c.tenant_id = tenants.id)::text`,
      webhookEndpoints: sql<string>`(select count(*) from webhook_endpoints w where w.tenant_id = tenants.id)::text`,
    })
    .from(tenants)
    .where(sql`${tenants.id} in (${sql.join(tenantIds.map((id) => sql`${id}`), sql`, `)})`);
  for (const row of rows) {
    counts.set(row.id, { apiKeys: Number(row.apiKeys), users: Number(row.users), contests: Number(row.contests), webhookEndpoints: Number(row.webhookEndpoints) });
  }
  return counts;
}

/** The tenant a `/tenants/:tenantId/*` route loaded; every handler under it can rely on it. */
export function tenantOf(c: { get(key: 'tenant'): Tenant | undefined }): Tenant {
  const tenant = c.get('tenant');
  if (tenant === undefined) throw new Error('tenant route reached without a loaded tenant');
  return tenant;
}

export function tenantsRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/', async (c) => {
    const db = c.get('db');
    const rows = await listTenants(db);
    const counts = await countsFor(
      db,
      rows.map((row) => row.id),
    );
    return ok(c, { tenants: rows.map((row) => tenantResource(row, counts.get(row.id) ?? { apiKeys: 0, users: 0, contests: 0, webhookEndpoints: 0 })) });
  });

  routes.get('/:tenantId', async (c) => {
    const tenant = tenantOf(c);
    const db = c.get('db');
    const counts = await countsFor(db, [tenant.id]);
    const body: TenantDetailResource = { ...tenantResource(tenant, counts.get(tenant.id) ?? { apiKeys: 0, users: 0, contests: 0, webhookEndpoints: 0 }), origins: await activeOrigins(db, tenant.id as Id<'tnt'>) };
    return ok(c, body);
  });

  routes.post('/:tenantId/status', requireAdmin(), async (c) => {
    const tenant = tenantOf(c);
    const body = parseBody(c, statusSchema);
    const updated = await setTenantStatus(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      status: body.status,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      actor: c.get('actor'),
      requestId: c.get('requestId'),
    });
    const counts = await countsFor(c.get('db'), [tenant.id]);
    return ok(c, tenantResource(updated, counts.get(tenant.id) ?? { apiKeys: 0, users: 0, contests: 0, webhookEndpoints: 0 }));
  });

  routes.get('/:tenantId/api-keys', async (c) => {
    const tenant = tenantOf(c);
    const keys = await listApiKeys(c.get('db'), tenant.id as Id<'tnt'>);
    return ok(c, { apiKeys: keys.map((key) => apiKeyResource(key, null)) });
  });

  routes.post('/:tenantId/api-keys', requireAdmin(), async (c) => {
    const tenant = tenantOf(c);
    const body = parseBody(c, createKeySchema);
    const created = await createApiKey(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      kind: body.kind,
      environment: body.environment,
      scopes: body.scopes,
      label: body.label ?? null,
      actor: c.get('actor'),
      requestId: c.get('requestId'),
    });
    c.get('logger').info('api key created from console', { keyId: created.key.id, tenantId: tenant.id, keyPrefix: created.key.keyPrefix });
    return okOnce(c, apiKeyResource(created.key, created.plaintext), apiKeyResource(created.key, null), 201);
  });

  routes.post('/:tenantId/api-keys/:keyId/revoke', requireAdmin(), async (c) => {
    const tenant = tenantOf(c);
    const keyId = param(keyIdSchema, 'keyId', c.req.param('keyId'));
    parseBody(c, emptySchema);
    const revoked = await revokeApiKey(c.get('db'), { tenantId: tenant.id as Id<'tnt'>, keyId, actor: c.get('actor'), requestId: c.get('requestId') });
    return ok(c, apiKeyResource(revoked, null));
  });

  return routes;
}

/** The tenant named in the path, or undefined when the id is not a tenant. */
export async function findTenant(db: DbOrTx, tenantId: string): Promise<Tenant | undefined> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return row;
}
