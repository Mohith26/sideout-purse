import { randomBytes } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@purse/types';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { webhookEndpoints, type WebhookEndpoint, type WebhookEndpointStatusValue } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { decryptSecret, encryptSecret, type ProcessKeys } from '../secrets';
import { WebhookError } from './errors';

/**
 * Webhook endpoints (spec 4.1, 4.9): where a tenant receives events. The signing secret
 * is minted here (`whsec_` and 32 random bytes), handed back exactly once, and stored
 * only as an AES-256-GCM envelope under the process's `webhook-secrets` key with the
 * endpoint id as associated data; the dispatcher opens it to sign. A URL must be `https`
 * except on a loopback host, so a production endpoint cannot be plain HTTP. Every change
 * is audited.
 */
export const SECRET_PREFIX = 'whsec_';
const URL_MAX = 2000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type CreateEndpointInput = {
  tenantId: Id<'tnt'>;
  url: string;
  subscribedEvents: readonly WebhookEventType[];
  description?: string | null;
  actor?: Actor;
  requestId?: string;
};

export type CreatedEndpoint = { endpoint: WebhookEndpoint; secret: string };

export function validateEndpointUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookError('invalid_input', 'url must be an absolute URL', { field: 'url' });
  }
  if (url.length > URL_MAX || /\s/.test(url)) throw new WebhookError('invalid_input', `url must be at most ${URL_MAX} characters with no whitespace`, { field: 'url' });
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed;
  throw new WebhookError('url_not_allowed', 'Webhook URLs must be https:// (plain http is allowed only on localhost)', { url });
}

function validateEvents(events: readonly WebhookEventType[]): WebhookEventType[] {
  const unique = [...new Set(events)];
  if (unique.length === 0) throw new WebhookError('invalid_input', 'subscribedEvents must name at least one event', { field: 'subscribedEvents' });
  for (const event of unique) {
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event)) {
      throw new WebhookError('invalid_input', `Unknown event type ${String(event)}`, { field: 'subscribedEvents', events: [...WEBHOOK_EVENT_TYPES] });
    }
  }
  return unique.sort();
}

function validateDescription(description: string | null | undefined): string | null {
  if (description === undefined || description === null) return null;
  const trimmed = description.trim();
  if (trimmed === '' || trimmed.length > 200) throw new WebhookError('invalid_input', 'description must be 1 to 200 characters when given', { field: 'description' });
  return trimmed;
}

export function mintSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** What an audit row or the API may show of an endpoint: never the envelope. */
export function publicFields(endpoint: WebhookEndpoint): Record<string, unknown> {
  return { id: endpoint.id, tenantId: endpoint.tenantId, url: endpoint.url, subscribedEvents: endpoint.subscribedEvents, status: endpoint.status, description: endpoint.description };
}

export async function createEndpoint(db: DbOrTx, keys: ProcessKeys, input: CreateEndpointInput): Promise<CreatedEndpoint> {
  const url = validateEndpointUrl(input.url).toString();
  const subscribedEvents = validateEvents(input.subscribedEvents);
  const description = validateDescription(input.description);
  const id = newId('whe');
  const secret = mintSecret();
  return db.transaction(async (tx) => {
    const [endpoint] = await tx
      .insert(webhookEndpoints)
      .values({ id, tenantId: input.tenantId, url, signingSecret: encryptSecret(keys['webhook-secrets'], secret, id), subscribedEvents, description })
      .returning();
    if (endpoint === undefined) throw new Error('webhook_endpoints insert returned no row');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'webhook_endpoint.created',
      subject: endpoint.id,
      before: null,
      after: publicFields(endpoint),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { endpoint, secret };
  });
}

export async function getEndpoint(db: DbOrTx, tenantId: Id<'tnt'>, endpointId: string): Promise<WebhookEndpoint> {
  if (!isId(endpointId, 'whe')) throw new WebhookError('endpoint_not_found', `No webhook endpoint ${endpointId}`, { endpointId });
  const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId));
  if (row === undefined) throw new WebhookError('endpoint_not_found', `No webhook endpoint ${endpointId}`, { endpointId });
  if (row.tenantId !== tenantId) throw new WebhookError('endpoint_wrong_tenant', `Webhook endpoint ${endpointId} belongs to another tenant`, { endpointId });
  return row;
}

export async function listEndpoints(db: DbOrTx, tenantId: Id<'tnt'>): Promise<WebhookEndpoint[]> {
  return db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId)).orderBy(desc(webhookEndpoints.createdAt));
}

/** The enabled endpoints of a tenant that subscribe to `type`: the fan-out list `emitEvent` writes deliveries for. */
export async function subscribedEndpoints(db: DbOrTx, tenantId: Id<'tnt'>, type: WebhookEventType): Promise<WebhookEndpoint[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.status, 'enabled'), sql`${type} = any(${webhookEndpoints.subscribedEvents})`))
    .orderBy(webhookEndpoints.id);
}

export type UpdateEndpointInput = {
  tenantId: Id<'tnt'>;
  endpointId: string;
  url?: string;
  subscribedEvents?: readonly WebhookEventType[];
  status?: WebhookEndpointStatusValue;
  description?: string | null;
  actor?: Actor;
  requestId?: string;
};

export async function updateEndpoint(db: DbOrTx, input: UpdateEndpointInput): Promise<WebhookEndpoint> {
  const patch: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (input.url !== undefined) patch.url = validateEndpointUrl(input.url).toString();
  if (input.subscribedEvents !== undefined) patch.subscribedEvents = validateEvents(input.subscribedEvents);
  if (input.status !== undefined) patch.status = input.status;
  if (input.description !== undefined) patch.description = validateDescription(input.description);
  return db.transaction(async (tx) => {
    const before = await getEndpoint(tx, input.tenantId, input.endpointId);
    if (Object.keys(patch).length === 0) return before;
    const [after] = await tx
      .update(webhookEndpoints)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(webhookEndpoints.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`webhook_endpoints update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'webhook_endpoint.updated',
      subject: before.id,
      before: publicFields(before),
      after: publicFields(after),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}

export type RotateSecretInput = { tenantId: Id<'tnt'>; endpointId: string; actor?: Actor; requestId?: string };

/** Mint a new secret and store its envelope; the old one stops signing at once. Returned once. */
export async function rotateEndpointSecret(db: DbOrTx, keys: ProcessKeys, input: RotateSecretInput): Promise<CreatedEndpoint> {
  const secret = mintSecret();
  return db.transaction(async (tx) => {
    const before = await getEndpoint(tx, input.tenantId, input.endpointId);
    const [after] = await tx
      .update(webhookEndpoints)
      .set({ signingSecret: encryptSecret(keys['webhook-secrets'], secret, before.id), updatedAt: sql`now()` })
      .where(eq(webhookEndpoints.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`webhook_endpoints update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'webhook_endpoint.secret_rotated',
      subject: before.id,
      before: publicFields(before),
      after: publicFields(after),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { endpoint: after, secret };
  });
}

/** Open the envelope: the plaintext the dispatcher signs with. Never returned by the API. */
export function endpointSecret(keys: ProcessKeys, endpoint: WebhookEndpoint): string {
  return decryptSecret(keys['webhook-secrets'], endpoint.signingSecret, endpoint.id);
}
