import { desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_ENDPOINT_STATUSES, WEBHOOK_EVENT_TYPES, type ConsoleDeliveryResource } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../../db/client';
import { tenants, webhookDeliveries, webhookEndpoints } from '../../db/schema';
import { parseBody } from '../../http/body';
import { ok, okOnce } from '../../http/envelope';
import { RequestValidationError } from '../../http/errors';
import { attemptsOf, createEndpoint, getEndpoint, listDeliveries, listEndpoints, loadDelivery, replayDelivery, rotateEndpointSecret, updateEndpoint, type DeliveryWithAttempts } from '../../webhooks';
import { param } from '../v1/schemas';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { consoleDeliveryResource, consoleEndpointResource } from './serialize';
import { tenantOf } from './tenants';

/**
 * `/console/tenants/:tenantId/webhooks` and `/console/webhooks` (spec 4.9, 4.10):
 * endpoints (create with the secret shown once, update, rotate) and the delivery log with
 * every attempt, per endpoint or across every tenant, with replay. A replay is a new
 * delivery of the same event (docs/decisions.md, phase 4); the console's replay takes an
 * `Idempotency-Key` like every mutation under a tenant, so a double click queues one.
 */
const createSchema = z
  .object({
    url: z.string().min(1).max(2000),
    subscribedEvents: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
    description: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    url: z.string().min(1).max(2000).optional(),
    subscribedEvents: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length).optional(),
    status: z.enum(WEBHOOK_ENDPOINT_STATUSES).optional(),
    description: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

const emptySchema = z.object({}).strict();
const endpointIdSchema = z.string().regex(/^whe_[0-9a-f-]{36}$/, 'must be a webhook endpoint id (whe_...)');
const deliveryIdSchema = z.string().regex(/^whd_[0-9a-f-]{36}$/, 'must be a webhook delivery id (whd_...)');
const listQuerySchema = z.object({ status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

type Context = { tenantName: string; endpointUrl: string };

/** Tenant names and endpoint urls for a batch of deliveries, two queries however many there are. */
async function contextsFor(db: DbOrTx, deliveries: readonly DeliveryWithAttempts[]): Promise<Map<string, Context>> {
  const endpointIds = [...new Set(deliveries.map((each) => each.delivery.endpointId))];
  const contexts = new Map<string, Context>();
  if (endpointIds.length === 0) return contexts;
  const rows = await db
    .select({ endpointId: webhookEndpoints.id, url: webhookEndpoints.url, tenantName: tenants.name })
    .from(webhookEndpoints)
    .innerJoin(tenants, eq(tenants.id, webhookEndpoints.tenantId))
    .where(sql`${webhookEndpoints.id} in (${sql.join(endpointIds.map((id) => sql`${id}`), sql`, `)})`);
  const byEndpoint = new Map(rows.map((row) => [row.endpointId, { tenantName: row.tenantName, endpointUrl: row.url }]));
  for (const each of deliveries) {
    const context = byEndpoint.get(each.delivery.endpointId);
    if (context !== undefined) contexts.set(each.delivery.id, context);
  }
  return contexts;
}

async function describe(db: DbOrTx, deliveries: readonly DeliveryWithAttempts[]): Promise<ConsoleDeliveryResource[]> {
  const contexts = await contextsFor(db, deliveries);
  return deliveries.map((each) => consoleDeliveryResource(each, contexts.get(each.delivery.id) ?? { tenantName: '', endpointUrl: '' }));
}

export function tenantWebhookRoutes(deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/endpoints', async (c) => {
    const tenant = tenantOf(c);
    const endpoints = await listEndpoints(c.get('db'), tenant.id as Id<'tnt'>);
    return ok(c, { endpoints: endpoints.map((endpoint) => consoleEndpointResource(endpoint, null)) });
  });

  routes.post('/endpoints', async (c) => {
    const tenant = tenantOf(c);
    const body = parseBody(c, createSchema);
    const created = await createEndpoint(c.get('db'), deps.keys, deps.webhookPolicy, {
      tenantId: tenant.id as Id<'tnt'>,
      url: body.url,
      subscribedEvents: body.subscribedEvents,
      description: body.description ?? null,
      actor: c.get('actor'),
      requestId: c.get('requestId'),
    });
    return okOnce(c, consoleEndpointResource(created.endpoint, created.secret), consoleEndpointResource(created.endpoint, null), 201);
  });

  routes.get('/endpoints/:id', async (c) => {
    const tenant = tenantOf(c);
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    return ok(c, consoleEndpointResource(await getEndpoint(c.get('db'), tenant.id as Id<'tnt'>, endpointId), null));
  });

  routes.patch('/endpoints/:id', async (c) => {
    const tenant = tenantOf(c);
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, updateSchema);
    const updated = await updateEndpoint(c.get('db'), deps.webhookPolicy, {
      tenantId: tenant.id as Id<'tnt'>,
      endpointId,
      ...(body.url === undefined ? {} : { url: body.url }),
      ...(body.subscribedEvents === undefined ? {} : { subscribedEvents: body.subscribedEvents }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.description === undefined ? {} : { description: body.description }),
      actor: c.get('actor'),
      requestId: c.get('requestId'),
    });
    return ok(c, consoleEndpointResource(updated, null));
  });

  routes.post('/endpoints/:id/rotate', async (c) => {
    const tenant = tenantOf(c);
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    parseBody(c, emptySchema);
    const rotated = await rotateEndpointSecret(c.get('db'), deps.keys, { tenantId: tenant.id as Id<'tnt'>, endpointId, actor: c.get('actor'), requestId: c.get('requestId') });
    return okOnce(c, consoleEndpointResource(rotated.endpoint, rotated.secret), consoleEndpointResource(rotated.endpoint, null));
  });

  routes.get('/endpoints/:id/deliveries', async (c) => {
    const tenant = tenantOf(c);
    const tenantId = tenant.id as Id<'tnt'>;
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    await getEndpoint(c.get('db'), tenantId, endpointId);
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new RequestValidationError(query.error, ['query']);
    const deliveries = await listDeliveries(c.get('db'), { tenantId, endpointId, ...(query.data.status === undefined ? {} : { status: query.data.status }), ...(query.data.limit === undefined ? {} : { limit: query.data.limit }) });
    return ok(c, { deliveries: await describe(c.get('db'), deliveries) });
  });

  routes.get('/deliveries/:id', async (c) => {
    const tenant = tenantOf(c);
    const deliveryId = param(deliveryIdSchema, 'id', c.req.param('id'));
    const delivery = await loadDelivery(c.get('db'), deliveryId, tenant.id as Id<'tnt'>);
    return ok(c, (await describe(c.get('db'), [delivery]))[0]);
  });

  routes.post('/deliveries/:id/replay', async (c) => {
    const tenant = tenantOf(c);
    const deliveryId = param(deliveryIdSchema, 'id', c.req.param('id'));
    parseBody(c, emptySchema);
    const replay = await replayDelivery(c.get('db'), { deliveryId, tenantId: tenant.id as Id<'tnt'>, actor: c.get('actor'), requestId: c.get('requestId') });
    c.get('logger').info('webhook delivery replayed from console', { deliveryId, replayId: replay.id, eventId: replay.eventId });
    return ok(c, (await describe(c.get('db'), [{ delivery: replay, attempts: [] }]))[0], 201);
  });

  return routes;
}

const globalQuerySchema = z
  .object({
    status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
    tenantId: z.string().regex(/^tnt_[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** `/console/webhooks/deliveries`: the log across every tenant, newest first, by status. */
export function globalWebhookRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/deliveries', async (c) => {
    const query = globalQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new RequestValidationError(query.error, ['query']);
    const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 200);
    const db = c.get('db');
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(
        sql`${query.data.status === undefined ? sql`true` : sql`${webhookDeliveries.status} = ${query.data.status}::webhook_delivery_status`}
          and ${query.data.tenantId === undefined ? sql`true` : sql`${webhookDeliveries.tenantId} = ${query.data.tenantId}`}`,
      )
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(limit);
    const attempts = await attemptsOf(
      db,
      rows.map((row) => row.id),
    );
    const deliveries = rows.map((delivery) => ({ delivery, attempts: attempts.get(delivery.id) ?? [] }));
    return ok(c, { deliveries: await describe(db, deliveries) });
  });

  return routes;
}
