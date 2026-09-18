import type { WebhookEvent, WebhookEventData, WebhookEventType } from '@purse/types';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { webhookDeliveries, type WebhookDelivery, type WebhookEndpoint } from '../db/schema';
import { jsonSafe } from '../ledger/audit';
import { subscribedEndpoints } from './endpoints';

/**
 * The outbox. `emitEvent` runs inside the transaction that made the change it reports
 * (`transition`, `enterContest`, `withdrawEntry`, `startVerification`, `postEntry`) and
 * writes one `webhook_deliveries` row per enabled endpoint of the tenant that subscribes
 * to the type, all carrying the same event id and the same payload. If the transaction
 * rolls back, so do the deliveries: nothing is ever announced that did not happen, and
 * nothing that happened goes unannounced. The dispatcher (`dispatcher.ts`) then works
 * the rows off. A tenant with no subscribed endpoint produces no row and no event id.
 */
export type EmitEventInput<T extends WebhookEventType> = {
  tenantId: Id<'tnt'>;
  type: T;
  data: WebhookEventData[T];
  /** The event's instant; defaults to now. */
  now?: Date;
  /** The fan-out list, when the caller already looked it up (`postEntry` checks it before computing balances). */
  endpoints?: WebhookEndpoint[];
};

export type EmittedEvent = { eventId: Id<'evt'> | null; deliveries: WebhookDelivery[] };

export function buildEvent<T extends WebhookEventType>(input: EmitEventInput<T> & { eventId: Id<'evt'>; createdAt: Date }): WebhookEvent<T> {
  return { id: input.eventId, type: input.type, createdAt: input.createdAt.toISOString(), tenantId: input.tenantId, data: input.data } as WebhookEvent<T>;
}

export async function emitEvent<T extends WebhookEventType>(tx: DbOrTx, input: EmitEventInput<T>): Promise<EmittedEvent> {
  const endpoints = input.endpoints ?? (await subscribedEndpoints(tx, input.tenantId, input.type));
  if (endpoints.length === 0) return { eventId: null, deliveries: [] };
  const eventId = newId('evt');
  const now = input.now ?? new Date();
  const payload = jsonSafe(buildEvent({ ...input, eventId, createdAt: now }) as unknown as Record<string, unknown>);
  const deliveries = await tx
    .insert(webhookDeliveries)
    .values(
      endpoints.map((endpoint) => ({
        id: newId('whd'),
        tenantId: input.tenantId,
        endpointId: endpoint.id,
        eventId,
        eventType: input.type,
        payload,
        nextAttemptAt: now,
      })),
    )
    .returning();
  return { eventId, deliveries };
}
