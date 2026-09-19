import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { signWebhook } from '@purse/sdk';
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_EVENT_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from '@purse/types';
import { newId } from '@repo/ids';
import { errorFields, type Logger } from '@repo/logger';

import type { Db } from '../db/client';
import { webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints, type WebhookDelivery, type WebhookEndpoint } from '../db/schema';
import type { ProcessKeys } from '../secrets';
import { checkDestination, type CheckedDestination, type DestinationPolicy } from './destination';
import { endpointSecret } from './endpoints';
import { isWebhookError } from './errors';
import { retryDelayMs } from './schedule';
import { DEFAULT_LIMITS, nodeTransport, type TransportLimits, type WebhookTransport } from './transport';

/**
 * The webhook dispatcher (spec 4.9): an in-process worker started with the API that works
 * `webhook_deliveries` off. Each cycle leases the due rows (`status` pending or failed,
 * `next_attempt_at` reached, no live lease, endpoint enabled) with `FOR UPDATE SKIP
 * LOCKED`, so several processes, or one restarted mid-flight, never attempt one delivery
 * twice at once: a lease outlives the request timeout, and a crashed process's lease
 * simply expires. Every attempt is one signed POST with a ten-second timeout, recorded in
 * `webhook_delivery_attempts` whatever happened; a 2xx marks the delivery `delivered`, a
 * failure schedules the next attempt from `schedule.ts`, and the eighth failure marks it
 * `dead`. The body sent is the stored payload as JSON, identical on every attempt, and
 * the signature is `@purse/sdk`'s `signWebhook`, the same code a receiver verifies with.
 *
 * Every attempt re-checks the destination (`destination.ts`) before it signs anything:
 * an endpoint stored before the check existed, or one whose hostname has since moved to a
 * private address, is refused here rather than delivered to. The refusal is recorded as
 * an ordinary failed attempt carrying its reason, so the console's delivery log shows an
 * operator what to fix and the retry schedule runs out as usual. The POST itself goes
 * through `transport.ts`, pinned to the address that was checked.
 *
 * The clock, the random source and the transport are injected so the demo test
 * (`test/webhooks/dispatcher.test.ts`) walks a day of retries in seconds against a real
 * local receiver.
 */
export type DispatcherDeps = {
  db: Db;
  keys: ProcessKeys;
  logger: Logger;
  /** Which destinations this deployment will deliver to (`destination.ts`). */
  policy: DestinationPolicy;
  /** How an attempt leaves the process; defaults to the pinned `node:http(s)` transport. */
  transport?: WebhookTransport;
  now?: () => Date;
  random?: () => number;
  /** Per-attempt total timeout. Spec 4.9 says ten seconds; the lease must outlive it. */
  deliveryTimeoutMs?: number;
  /** How long one attempt may spend establishing the connection; capped by the total timeout. */
  connectTimeoutMs?: number;
  /** How much of a receiver's response is read before the attempt is abandoned. */
  maxResponseBytes?: number;
  pollIntervalMs?: number;
  /** Deliveries leased per cycle. */
  batchSize?: number;
  leaseMs?: number;
  /** Names this process in `locked_by`. */
  instanceId?: string;
};

export type CycleReport = { claimed: number; delivered: number; retried: number; dead: number };

export type AttemptOutcome = { responseStatus: number | null; error: string | null; startedAt: Date; finishedAt: Date };

const USER_AGENT = 'Purse-Webhooks/1';
const ERROR_MAX = 500;
/** The prefix an attempt's `error` carries when the destination, not the receiver, is why nothing was sent. */
export const DESTINATION_REFUSED = 'destination_refused';

function truncate(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

export function describeFailure(error: unknown): string {
  return truncate(error instanceof Error ? `${error.name}: ${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ''}` : String(error));
}

export class WebhookDispatcher {
  private readonly db: Db;
  private readonly keys: ProcessKeys;
  private readonly logger: Logger;
  private readonly policy: DestinationPolicy;
  private readonly transport: WebhookTransport;
  private readonly limits: TransportLimits;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly deliveryTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  readonly instanceId: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight: Promise<CycleReport> | undefined;
  private wakeRequested = false;

  constructor(deps: DispatcherDeps) {
    this.db = deps.db;
    this.keys = deps.keys;
    this.logger = deps.logger.child({ component: 'webhook-dispatcher' });
    this.policy = deps.policy;
    this.transport = deps.transport ?? nodeTransport;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.deliveryTimeoutMs = deps.deliveryTimeoutMs ?? DEFAULT_LIMITS.totalTimeoutMs;
    this.limits = {
      totalTimeoutMs: this.deliveryTimeoutMs,
      connectTimeoutMs: Math.min(deps.connectTimeoutMs ?? DEFAULT_LIMITS.connectTimeoutMs, this.deliveryTimeoutMs),
      maxResponseBytes: deps.maxResponseBytes ?? DEFAULT_LIMITS.maxResponseBytes,
    };
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.batchSize = deps.batchSize ?? 20;
    this.leaseMs = deps.leaseMs ?? Math.max(60_000, this.deliveryTimeoutMs * 3);
    this.instanceId = deps.instanceId ?? `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  }

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('webhook dispatcher started', { instanceId: this.instanceId, pollIntervalMs: this.pollIntervalMs, deliveryTimeoutMs: this.deliveryTimeoutMs });
    this.schedule(0);
  }

  /** Stop polling and wait for the cycle in flight, if any, to record its attempts. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.logger.info('webhook dispatcher stopped', { instanceId: this.instanceId });
  }

  /** Run a cycle as soon as the current one (if any) finishes, rather than at the next poll. */
  wake(): void {
    if (!this.running) return;
    if (this.inFlight !== undefined) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runOnce()
        .then((report) => {
          const again = this.wakeRequested || report.claimed === this.batchSize;
          this.wakeRequested = false;
          this.schedule(again ? 0 : this.pollIntervalMs);
        })
        .catch((error: unknown) => {
          this.logger.error('webhook dispatcher cycle failed', errorFields(error));
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** One cycle: lease what is due and attempt each, concurrently. Single-flight: a second call joins the first. */
  runOnce(): Promise<CycleReport> {
    if (this.inFlight !== undefined) return this.inFlight;
    const cycle = this.cycle().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = cycle;
    return cycle;
  }

  private async cycle(): Promise<CycleReport> {
    const claimed = await this.claim();
    const report: CycleReport = { claimed: claimed.length, delivered: 0, retried: 0, dead: 0 };
    await Promise.all(
      claimed.map(async (delivery) => {
        const result = await this.attempt(delivery);
        if (result === 'delivered') report.delivered += 1;
        else if (result === 'dead') report.dead += 1;
        else report.retried += 1;
      }),
    );
    return report;
  }

  /** Lease the due deliveries whose endpoint is enabled. The lease is written by the same statement that picks them. */
  private async claim(): Promise<WebhookDelivery[]> {
    const now = this.now().toISOString();
    const until = new Date(this.now().getTime() + this.leaseMs).toISOString();
    const rows = await this.db.execute<Record<string, unknown>>(sql`
      update webhook_deliveries d
      set locked_until = ${until}::timestamptz, locked_by = ${this.instanceId}, updated_at = ${now}::timestamptz
      where d.id in (
        select wd.id from webhook_deliveries wd
        join webhook_endpoints we on we.id = wd.endpoint_id
        where wd.status in ('pending', 'failed')
          and wd.next_attempt_at <= ${now}::timestamptz
          and (wd.locked_until is null or wd.locked_until < ${now}::timestamptz)
          and we.status = 'enabled'
        order by wd.next_attempt_at, wd.id
        limit ${this.batchSize}
        for update of wd skip locked
      )
      returning d.*
    `);
    return rows.map(rowToDelivery);
  }

  private async attempt(delivery: WebhookDelivery): Promise<'delivered' | 'retried' | 'dead'> {
    const [endpoint] = await this.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, delivery.endpointId));
    if (endpoint === undefined) throw new Error(`webhook endpoint ${delivery.endpointId} of delivery ${delivery.id} is missing`);
    const attempt = delivery.attempt + 1;
    const outcome = await this.post(delivery, endpoint, attempt);
    const succeeded = outcome.responseStatus !== null && outcome.responseStatus >= 200 && outcome.responseStatus < 300;
    const exhausted = !succeeded && attempt >= delivery.maxAttempts;
    const delay = succeeded || exhausted ? undefined : retryDelayMs(attempt, this.random);
    const status = succeeded ? 'delivered' : exhausted ? 'dead' : 'failed';
    const nextAttemptAt = delay === undefined ? delivery.nextAttemptAt : new Date(outcome.finishedAt.getTime() + delay);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(webhookDeliveryAttempts)
        .values({
          id: newId('wha'),
          deliveryId: delivery.id,
          attempt,
          startedAt: outcome.startedAt,
          finishedAt: outcome.finishedAt,
          responseStatus: outcome.responseStatus,
          error: outcome.error,
          durationMs: Math.max(0, outcome.finishedAt.getTime() - outcome.startedAt.getTime()),
        })
        .onConflictDoNothing();
      const updated = await tx
        .update(webhookDeliveries)
        .set({
          attempt,
          status,
          responseStatus: outcome.responseStatus,
          nextAttemptAt,
          deliveredAt: succeeded ? outcome.finishedAt : null,
          lockedUntil: null,
          lockedBy: null,
          updatedAt: outcome.finishedAt,
        })
        .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.lockedBy, this.instanceId)))
        .returning({ id: webhookDeliveries.id });
      if (updated.length === 0) this.logger.warn('webhook delivery lease was lost before the attempt was recorded', { deliveryId: delivery.id, attempt });
    });

    const fields = { deliveryId: delivery.id, endpointId: endpoint.id, eventId: delivery.eventId, eventType: delivery.eventType, attempt, maxAttempts: delivery.maxAttempts, responseStatus: outcome.responseStatus, error: outcome.error, durationMs: outcome.finishedAt.getTime() - outcome.startedAt.getTime() };
    if (succeeded) this.logger.info('webhook delivered', fields);
    else if (exhausted) this.logger.error('webhook dead after the last attempt', fields);
    else this.logger.warn('webhook attempt failed; retry scheduled', { ...fields, nextAttemptAt: nextAttemptAt.toISOString() });
    return status === 'failed' ? 'retried' : status;
  }

  /** One signed POST to a re-checked, pinned destination. Never throws: a refusal, a refused connection or a timeout is an outcome with `error` set. */
  private async post(delivery: WebhookDelivery, endpoint: WebhookEndpoint, attempt: number): Promise<AttemptOutcome> {
    const startedAt = this.now();
    const body = JSON.stringify(delivery.payload);
    let secret: string;
    try {
      secret = endpointSecret(this.keys, endpoint);
    } catch (error) {
      // A secret that will not open never will; the attempt is recorded and the schedule runs out.
      return { responseStatus: null, error: describeFailure(error), startedAt, finishedAt: this.now() };
    }
    // The destination is judged again here, not only where it was registered: a hostname
    // that answered publicly then may answer privately now, and an endpoint stored before
    // this check existed has never been judged at all.
    let checked: CheckedDestination;
    try {
      checked = await checkDestination(endpoint.url, this.policy);
    } catch (error) {
      const detail = isWebhookError(error, 'url_not_allowed') ? error.detail['reason'] : undefined;
      const reason = typeof detail === 'string' && error instanceof Error ? `${detail}: ${error.message}` : describeFailure(error);
      this.logger.warn('webhook destination refused; the attempt was not sent', { deliveryId: delivery.id, endpointId: endpoint.id, url: endpoint.url, attempt, reason });
      return { responseStatus: null, error: truncate(`${DESTINATION_REFUSED}: ${reason}`), startedAt, finishedAt: this.now() };
    }
    if (checked.address === null) return { responseStatus: null, error: `${DESTINATION_REFUSED}: unresolvable: the destination host could not be resolved`, startedAt, finishedAt: this.now() };
    const signed = await signWebhook(body, secret, Math.floor(startedAt.getTime() / 1000));
    try {
      const response = await this.transport(
        {
          url: checked.url,
          address: checked.address,
          headers: {
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
            [WEBHOOK_SIGNATURE_HEADER]: signed.header,
            [WEBHOOK_EVENT_ID_HEADER]: delivery.eventId,
            [WEBHOOK_DELIVERY_ID_HEADER]: `${delivery.id}:${String(attempt)}`,
          },
          body,
        },
        this.limits,
      );
      return { responseStatus: response.status, error: null, startedAt, finishedAt: this.now() };
    } catch (error) {
      return { responseStatus: null, error: describeFailure(error), startedAt, finishedAt: this.now() };
    }
  }
}

/** A row from the raw claim statement, typed as drizzle would return it. */
function rowToDelivery(row: Record<string, unknown>): WebhookDelivery {
  const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
  const dateOrNull = (value: unknown): Date | null => (value === null || value === undefined ? null : date(value));
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    endpointId: String(row['endpoint_id']),
    eventId: String(row['event_id']),
    eventType: row['event_type'] as WebhookDelivery['eventType'],
    payload: row['payload'] as WebhookDelivery['payload'],
    attempt: Number(row['attempt']),
    maxAttempts: Number(row['max_attempts']),
    status: row['status'] as WebhookDelivery['status'],
    responseStatus: row['response_status'] === null ? null : Number(row['response_status']),
    nextAttemptAt: date(row['next_attempt_at']),
    deliveredAt: dateOrNull(row['delivered_at']),
    lockedUntil: dateOrNull(row['locked_until']),
    lockedBy: typeof row['locked_by'] === 'string' ? row['locked_by'] : null,
    replayOf: typeof row['replay_of'] === 'string' ? row['replay_of'] : null,
    createdAt: date(row['created_at']),
    updatedAt: date(row['updated_at']),
  };
}
