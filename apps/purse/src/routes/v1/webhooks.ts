import { Hono } from 'hono';
import { z } from 'zod';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_ENDPOINT_STATUSES, WEBHOOK_EVENT_TYPES } from '@purse/types';
import type { Id } from '@repo/ids';

import { parseBody } from '../../http/body';
import { ok, okOnce } from '../../http/envelope';
import { RequestValidationError } from '../../http/errors';
import { createEndpoint, getEndpoint, listDeliveries, listEndpoints, loadDelivery, replayDelivery, rotateEndpointSecret, updateEndpoint } from '../../webhooks';
import type { V1Deps, V1Scope } from './scope';
import { param } from './schemas';
import { deliveryResource, endpointResource } from './serialize';

/**
 * `/v1/webhooks` (spec 4.9), on the secret key: endpoints (create with the secret shown
 * once, list, read, update, rotate the secret) and the delivery log (per endpoint or by
 * id, every attempt included) with replay. The operator console reaches the same log
 * through `/internal/webhooks` (phase 5).
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

export function webhooksRoutes(deps: V1Deps) {
  const routes = new Hono<V1Scope>();

  routes.post('/endpoints', async (c) => {
    const auth = c.get('auth');
    const body = parseBody(c, createSchema);
    const created = await createEndpoint(c.get('db'), deps.keys, {
      tenantId: auth.tenant.id as Id<'tnt'>,
      url: body.url,
      subscribedEvents: body.subscribedEvents,
      description: body.description ?? null,
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    const resource = endpointResource(created.endpoint, created.secret);
    return okOnce(c, resource, endpointResource(created.endpoint, null), 201);
  });

  routes.get('/endpoints', async (c) => {
    const auth = c.get('auth');
    const endpoints = await listEndpoints(c.get('db'), auth.tenant.id as Id<'tnt'>);
    return ok(c, { endpoints: endpoints.map((endpoint) => endpointResource(endpoint, null)) });
  });

  routes.get('/endpoints/:id', async (c) => {
    const auth = c.get('auth');
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    return ok(c, endpointResource(await getEndpoint(c.get('db'), auth.tenant.id as Id<'tnt'>, endpointId), null));
  });

  routes.patch('/endpoints/:id', async (c) => {
    const auth = c.get('auth');
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, updateSchema);
    const updated = await updateEndpoint(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      endpointId,
      ...(body.url === undefined ? {} : { url: body.url }),
      ...(body.subscribedEvents === undefined ? {} : { subscribedEvents: body.subscribedEvents }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.description === undefined ? {} : { description: body.description }),
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    return ok(c, endpointResource(updated, null));
  });

  routes.post('/endpoints/:id/rotate', async (c) => {
    const auth = c.get('auth');
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    parseBody(c, emptySchema);
    const rotated = await rotateEndpointSecret(c.get('db'), deps.keys, { tenantId: auth.tenant.id as Id<'tnt'>, endpointId, actor: auth.actor, requestId: c.get('requestId') });
    return okOnce(c, endpointResource(rotated.endpoint, rotated.secret), endpointResource(rotated.endpoint, null));
  });

  routes.get('/endpoints/:id/deliveries', async (c) => {
    const auth = c.get('auth');
    const tenantId = auth.tenant.id as Id<'tnt'>;
    const endpointId = param(endpointIdSchema, 'id', c.req.param('id'));
    await getEndpoint(c.get('db'), tenantId, endpointId);
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new RequestValidationError(query.error, ['query']);
    const deliveries = await listDeliveries(c.get('db'), { tenantId, endpointId, ...(query.data.status === undefined ? {} : { status: query.data.status }), ...(query.data.limit === undefined ? {} : { limit: query.data.limit }) });
    return ok(c, { deliveries: deliveries.map(deliveryResource) });
  });

  routes.get('/deliveries/:id', async (c) => {
    const auth = c.get('auth');
    const deliveryId = param(deliveryIdSchema, 'id', c.req.param('id'));
    return ok(c, deliveryResource(await loadDelivery(c.get('db'), deliveryId, auth.tenant.id as Id<'tnt'>)));
  });

  routes.post('/deliveries/:id/replay', async (c) => {
    const auth = c.get('auth');
    const deliveryId = param(deliveryIdSchema, 'id', c.req.param('id'));
    parseBody(c, emptySchema);
    const replay = await replayDelivery(c.get('db'), { deliveryId, tenantId: auth.tenant.id as Id<'tnt'>, actor: auth.actor, requestId: c.get('requestId') });
    return ok(c, deliveryResource({ delivery: replay, attempts: [] }), 201);
  });

  return routes;
}
