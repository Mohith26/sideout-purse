import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { WebhookDeliveryStatus } from '@purse/types';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints, type WebhookDelivery, type WebhookDeliveryAttempt } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { WebhookError } from './errors';

/**
 * The delivery log (spec 4.9): every delivery with every attempt, readable by the tenant
 * over the API and by the operator console (phase 5), and manual replay. A replay is a
 * new delivery of the same event to the same endpoint, `replay_of` naming the original,
 * with its own attempt count and schedule; the original's history stays as it was, and
 * the receiver sees the same event id and dedupes.
 */
export type DeliveryWithAttempts = { delivery: WebhookDelivery; attempts: WebhookDeliveryAttempt[] };

export async function getDelivery(db: DbOrTx, deliveryId: string, tenantId?: Id<'tnt'>): Promise<WebhookDelivery> {
  if (!isId(deliveryId, 'whd')) throw new WebhookError('delivery_not_found', `No webhook delivery ${deliveryId}`, { deliveryId });
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  if (row === undefined) throw new WebhookError('delivery_not_found', `No webhook delivery ${deliveryId}`, { deliveryId });
  if (tenantId !== undefined && row.tenantId !== tenantId) throw new WebhookError('delivery_wrong_tenant', `Webhook delivery ${deliveryId} belongs to another tenant`, { deliveryId });
  return row;
}

export async function attemptsOf(db: DbOrTx, deliveryIds: readonly string[]): Promise<Map<string, WebhookDeliveryAttempt[]>> {
  const byDelivery = new Map<string, WebhookDeliveryAttempt[]>();
  if (deliveryIds.length === 0) return byDelivery;
  const rows = await db
    .select()
    .from(webhookDeliveryAttempts)
    .where(inArray(webhookDeliveryAttempts.deliveryId, [...deliveryIds]))
    .orderBy(asc(webhookDeliveryAttempts.deliveryId), asc(webhookDeliveryAttempts.attempt));
  for (const row of rows) {
    const list = byDelivery.get(row.deliveryId) ?? [];
    list.push(row);
    byDelivery.set(row.deliveryId, list);
  }
  return byDelivery;
}

export async function loadDelivery(db: DbOrTx, deliveryId: string, tenantId?: Id<'tnt'>): Promise<DeliveryWithAttempts> {
  const delivery = await getDelivery(db, deliveryId, tenantId);
  const attempts = (await attemptsOf(db, [delivery.id])).get(delivery.id) ?? [];
  return { delivery, attempts };
}

export type ListDeliveriesInput = {
  tenantId: Id<'tnt'>;
  endpointId?: string;
  eventId?: string;
  status?: WebhookDeliveryStatus;
  limit?: number;
};

export const LIST_LIMIT_MAX = 200;

/** Newest first, with attempts. */
export async function listDeliveries(db: DbOrTx, input: ListDeliveriesInput): Promise<DeliveryWithAttempts[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), LIST_LIMIT_MAX);
  const conditions: SQL[] = [eq(webhookDeliveries.tenantId, input.tenantId)];
  if (input.endpointId !== undefined) conditions.push(eq(webhookDeliveries.endpointId, input.endpointId));
  if (input.eventId !== undefined) conditions.push(eq(webhookDeliveries.eventId, input.eventId));
  if (input.status !== undefined) conditions.push(eq(webhookDeliveries.status, input.status));
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit);
  const attempts = await attemptsOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((delivery) => ({ delivery, attempts: attempts.get(delivery.id) ?? [] }));
}

export type ReplayDeliveryInput = {
  deliveryId: string;
  /** When given, the delivery must belong to this tenant; the operator route passes none. */
  tenantId?: Id<'tnt'>;
  actor?: Actor;
  requestId?: string;
  now?: Date;
};

/** Queue the same event to the same endpoint again, as a new delivery due now. The endpoint must be enabled. */
export async function replayDelivery(db: DbOrTx, input: ReplayDeliveryInput): Promise<WebhookDelivery> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const original = await getDelivery(tx, input.deliveryId, input.tenantId);
    const [endpoint] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, original.endpointId));
    if (endpoint === undefined) throw new Error(`webhook endpoint ${original.endpointId} of delivery ${original.id} is missing`);
    if (endpoint.status !== 'enabled') {
      throw new WebhookError('endpoint_disabled', `Webhook endpoint ${endpoint.id} is disabled; enable it before replaying`, { endpointId: endpoint.id, deliveryId: original.id });
    }
    const [replay] = await tx
      .insert(webhookDeliveries)
      .values({
        id: newId('whd'),
        tenantId: original.tenantId,
        endpointId: original.endpointId,
        eventId: original.eventId,
        eventType: original.eventType,
        payload: original.payload,
        maxAttempts: original.maxAttempts,
        nextAttemptAt: now,
        replayOf: original.replayOf ?? original.id,
      })
      .returning();
    if (replay === undefined) throw new Error('webhook_deliveries insert returned no row');
    await recordAudit(tx, {
      tenantId: original.tenantId as Id<'tnt'>,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'webhook_delivery.replayed',
      subject: original.id,
      before: { id: original.id, status: original.status, attempt: original.attempt, eventId: original.eventId },
      after: { replayId: replay.id, eventId: replay.eventId, endpointId: replay.endpointId },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return replay;
  });
}
