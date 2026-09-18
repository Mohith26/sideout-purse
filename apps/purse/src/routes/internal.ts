import { createHash, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import type { Db } from '../db/client';
import { reconcile } from '../ledger';
import { ApiFailure, ok } from '../http/envelope';
import type { RequestScope } from '../http/request-id';
import { loadDelivery, replayDelivery } from '../webhooks';
import { deliveryResource } from './v1/serialize';

/**
 * `GET /internal/reconcile`, spec 4.2.4. Runs every invariant and answers with the
 * report: 200 when clean, 500 in the error envelope (report in `detail`) when not, so a
 * scheduled caller can alarm on the status alone.
 *
 * `POST /internal/webhooks/deliveries/:id/replay` (spec 4.9, "manually replay any
 * delivery") queues the delivery's event to its endpoint again as a new delivery, whatever
 * tenant it belongs to; `GET /internal/webhooks/deliveries/:id` reads one with its
 * attempts. The operator console wires both in phase 5.
 *
 * Access: a bearer `INTERNAL_API_TOKEN`. When no token is configured the routes are closed
 * (403) in every environment except `test`, where they are open so the harness can
 * exercise them. Never open in production by accident: there is no "development" shortcut.
 */
export type InternalDeps = {
  db: Db;
  internalApiToken: string | undefined;
  nodeEnv: 'development' | 'test' | 'production';
};

const DELIVERY_ID = /^whd_[0-9a-f-]{36}$/;

export function internalRoutes(deps: InternalDeps) {
  const routes = new Hono<RequestScope>();

  routes.get('/internal/webhooks/deliveries/:id', async (c) => {
    authorize(c.req.header('Authorization'), deps);
    const id = c.req.param('id');
    if (!DELIVERY_ID.test(id)) throw new ApiFailure({ type: 'invalid_request', code: 'validation_failed', message: 'id must be a webhook delivery id (whd_...)' });
    return ok(c, deliveryResource(await loadDelivery(deps.db, id)));
  });

  routes.post('/internal/webhooks/deliveries/:id/replay', async (c) => {
    authorize(c.req.header('Authorization'), deps);
    const id = c.req.param('id');
    if (!DELIVERY_ID.test(id)) throw new ApiFailure({ type: 'invalid_request', code: 'validation_failed', message: 'id must be a webhook delivery id (whd_...)' });
    const replay = await replayDelivery(deps.db, { deliveryId: id, actor: { kind: 'operator', ref: 'internal' }, requestId: c.get('requestId') });
    c.get('logger').info('webhook delivery replayed', { deliveryId: id, replayId: replay.id, eventId: replay.eventId });
    return ok(c, deliveryResource({ delivery: replay, attempts: [] }), 201);
  });

  return routes.get('/internal/reconcile', async (c) => {
    authorize(c.req.header('Authorization'), deps);

    const report = await reconcile(deps.db);
    const logger = c.get('logger');
    if (report.ok) {
      logger.info('reconcile clean', { durationMs: report.durationMs });
      return ok(c, report);
    }
    const failed = report.invariants.filter((result) => !result.ok).map((result) => result.id);
    logger.error('reconcile failed', { failed, invariants: report.invariants.filter((result) => !result.ok) });
    throw new ApiFailure(
      {
        type: 'internal_error',
        code: 'invariant_violation',
        message: `${failed.length} invariant(s) failed: ${failed.join(', ')}`,
        detail: report,
      },
      500,
    );
  });
}

function authorize(header: string | undefined, deps: InternalDeps): void {
  if (deps.internalApiToken === undefined) {
    if (deps.nodeEnv === 'test') return;
    throw new ApiFailure(
      { type: 'permission_error', code: 'internal_api_closed', message: 'INTERNAL_API_TOKEN is not configured; the internal API is closed' },
      403,
    );
  }
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (presented === undefined || !constantTimeEqual(presented, deps.internalApiToken)) {
    throw new ApiFailure(
      { type: 'authentication_error', code: 'invalid_internal_token', message: 'A valid bearer token is required' },
      401,
    );
  }
}

/** Compare digests so the comparison takes the same time whatever the lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
