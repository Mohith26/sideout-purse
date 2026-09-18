import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES } from '@purse/types';
import { createLogger } from '@repo/logger';

import { closeContest, previewSettlement } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { webhookDeliveries, webhookDeliveryAttempts, type WebhookDelivery, type WebhookEndpoint } from '../../src/db/schema';
import { issuePromoPoints } from '../../src/ledger';
import { findAccount } from '../../src/ledger/accounts';
import { BACKOFF_SECONDS, WEBHOOK_MAX_ATTEMPTS, WebhookDispatcher, createEndpoint, listDeliveries, replayDelivery, updateEndpoint } from '../../src/webhooks';
import { OPERATOR, buildArena, inProgress, score, type Arena } from '../contests/fixtures';
import { connectMigrator, connectRuntime, harness, TEST_KEYS, type TestHarness } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { SampleReceiver } from './receiver';

/**
 * The demo spec 4.9 asks for, as a test (acceptance criteria 15 and 16): a real local
 * receiver built with `@purse/sdk`'s `verifyWebhook`; take it down; settle a contest;
 * watch the deliveries queue and retry with growing delays, every attempt in the log;
 * bring it back; watch them drain, with the receiver deduping a replay by event id. Then
 * the eighth failure marks a delivery dead, the operator replays it, and two dispatcher
 * instances over the same rows never attempt one delivery twice. The clock and the
 * jitter draw are injected, so a day of retries takes a second.
 */
describe('webhook dispatcher', () => {
  let migrator: Database;
  let runtime: Database;
  let h: TestHarness;
  let arena: Arena;
  let endpoint: WebhookEndpoint;
  let secret: string;
  let receiver: SampleReceiver;
  let now: Date;
  const clock = (): Date => new Date(now);
  const advance = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };
  const logger = createLogger({ service: 'dispatcher-test', level: 'error', write: () => undefined });
  const dispatcher = (instanceId = 'test-a'): WebhookDispatcher =>
    new WebhookDispatcher({ db: runtime.db, keys: TEST_KEYS, logger, now: clock, random: () => 0.5, deliveryTimeoutMs: 1000, instanceId, batchSize: 50 });

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
    h = harness({ internalApiToken: 'internal-token-for-tests-1234' });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    // The outbox stamps rows with the real clock; the dispatcher's starts a minute ahead of it and is then advanced by hand.
    now = new Date(Date.now() + 60_000);
    arena = await buildArena(runtime.db, { users: 3, funding: 1000n });
    receiver = new SampleReceiver('placeholder', clock);
    const url = await receiver.start();
    const created = await createEndpoint(runtime.db, TEST_KEYS, { tenantId: arena.tenantId, url, subscribedEvents: WEBHOOK_EVENT_TYPES, description: 'demo receiver' });
    endpoint = created.endpoint;
    secret = created.secret;
    receiver.secret = secret;
  });
  afterEach(async () => {
    await receiver.stop();
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
    await h.close();
  });

  async function deliveriesOf(eventType?: string): Promise<WebhookDelivery[]> {
    const rows = await runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpoint.id)).orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id));
    return eventType === undefined ? rows : rows.filter((row) => row.eventType === eventType);
  }

  async function attemptsOf(deliveryId: string) {
    return runtime.db.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.deliveryId, deliveryId)).orderBy(asc(webhookDeliveryAttempts.attempt));
  }

  /** One credit per arena user: three `wallet.balance.changed` deliveries. */
  async function queueCredits(): Promise<WebhookDelivery[]> {
    const before = new Set((await deliveriesOf()).map((row) => row.id));
    for (const userId of arena.users) {
      const wallet = await findAccount(runtime.db, { tenantId: arena.tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS' });
      if (wallet === undefined) throw new Error('no wallet');
      await issuePromoPoints(runtime.db, { tenantId: arena.tenantId, asset: 'POINTS', promoLiabilityAccountId: arena.promo.id, walletAccountId: wallet.id, amount: 7n, idempotencyKey: key('credit') });
    }
    return (await deliveriesOf()).filter((row) => !before.has(row.id));
  }

  /** Settle a three-entrant contest through the real services: opened, locked, entries, scores, settled, payouts. */
  async function settleAContest(): Promise<string> {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [30, 20, 10]);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key('close') });
    return contest.id;
  }

  it('queues, retries with growing delays while the receiver is down, drains when it is back, and the log shows every attempt', async () => {
    // Take the receiver down, then settle a contest: every event the settlement produces is queued.
    await receiver.stop();
    const contestId = await settleAContest();
    const queued = await deliveriesOf();
    const types = queued.map((delivery) => delivery.eventType);
    expect(types.filter((type) => type === 'contest.opened')).toHaveLength(1);
    expect(types.filter((type) => type === 'contest.locked')).toHaveLength(1);
    expect(types.filter((type) => type === 'contest.entry.created')).toHaveLength(3);
    expect(types.filter((type) => type === 'contest.settled')).toHaveLength(1);
    // The three escrows and the three payouts each moved a wallet (funding predates the endpoint).
    expect(types.filter((type) => type === 'wallet.balance.changed')).toHaveLength(6);
    expect(queued.every((delivery) => delivery.status === 'pending' && delivery.attempt === 0)).toBe(true);
    const settled = queued.find((delivery) => delivery.eventType === 'contest.settled');
    expect(settled?.payload).toMatchObject({ id: settled?.eventId, type: 'contest.settled', tenantId: arena.tenantId, data: { contestId, state: 'settled', previousState: 'settling' } });

    // First attempts: the port refuses; every delivery is `failed` with a retry a minute out.
    const worker = dispatcher();
    const first = await worker.runOnce();
    expect(first).toEqual({ claimed: queued.length, delivered: 0, retried: queued.length, dead: 0 });
    let rows = await deliveriesOf();
    expect(rows.every((row) => row.status === 'failed' && row.attempt === 1 && row.responseStatus === null && row.lockedBy === null)).toBe(true);
    for (const row of rows) {
      expect(row.nextAttemptAt.getTime() - now.getTime()).toBe((BACKOFF_SECONDS[0] ?? 0) * 1000);
      const attempts = await attemptsOf(row.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.error).toMatch(/ECONNREFUSED|fetch failed/);
    }

    // Not due yet: nothing is claimed. Due: the second attempt fails and the wait grows to five minutes.
    expect(await worker.runOnce()).toEqual({ claimed: 0, delivered: 0, retried: 0, dead: 0 });
    advance((BACKOFF_SECONDS[0] ?? 0) * 1000);
    expect((await worker.runOnce()).retried).toBe(queued.length);
    rows = await deliveriesOf();
    for (const row of rows) {
      expect(row.attempt).toBe(2);
      expect(row.nextAttemptAt.getTime() - now.getTime()).toBe((BACKOFF_SECONDS[1] ?? 0) * 1000);
      expect(await attemptsOf(row.id)).toHaveLength(2);
    }

    // Bring the receiver back; when the retries come due they drain, signed and verified.
    await receiver.start();
    advance((BACKOFF_SECONDS[1] ?? 0) * 1000);
    const drained = await worker.runOnce();
    expect(drained).toEqual({ claimed: queued.length, delivered: queued.length, retried: 0, dead: 0 });
    rows = await deliveriesOf();
    expect(rows.every((row) => row.status === 'delivered' && row.attempt === 3 && row.responseStatus === 200 && row.deliveredAt !== null)).toBe(true);
    expect(receiver.rejected).toEqual([]);
    expect(receiver.received.map((each) => each.eventId).sort()).toEqual(queued.map((each) => each.eventId).sort());
    expect(receiver.duplicates).toBe(0);
    for (const row of rows) {
      const attempts = await attemptsOf(row.id);
      expect(attempts.map((attempt) => [attempt.attempt, attempt.responseStatus, attempt.error === null])).toEqual([
        [1, null, false],
        [2, null, false],
        [3, 200, true],
      ]);
    }
    // The log, as the API serves it, carries the same picture.
    const log = await listDeliveries(runtime.db, { tenantId: arena.tenantId, endpointId: endpoint.id, limit: 200 });
    expect(log).toHaveLength(queued.length);
    expect(log.every((each) => each.attempts.length === 3 && each.delivery.status === 'delivered')).toBe(true);

    // A replay is a fresh delivery of the same event; the receiver has seen the id and dedupes.
    const settledDelivery = rows.find((row) => row.eventType === 'contest.settled');
    if (settledDelivery === undefined) throw new Error('no settled delivery');
    const replayed = await h.app.request(`/internal/webhooks/deliveries/${settledDelivery.id}/replay`, { method: 'POST', headers: { Authorization: 'Bearer internal-token-for-tests-1234' } });
    expect(replayed.status).toBe(201);
    const replayBody = (await replayed.json()) as { data: { id: string; eventId: string; replayOf: string; status: string; attempt: number } };
    expect(replayBody.data).toMatchObject({ eventId: settledDelivery.eventId, replayOf: settledDelivery.id, status: 'pending', attempt: 0 });
    expect(await worker.runOnce()).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    expect(receiver.duplicates).toBe(1);
    expect(receiver.received).toHaveLength(queued.length);
    const original = (await runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, settledDelivery.id)))[0];
    expect(original?.attempt).toBe(3);
  });

  it('marks a delivery dead after the eighth failed attempt, roughly a day later, and an operator can replay it', async () => {
    receiver.mode = 'failing';
    const wallet = await findAccount(runtime.db, { tenantId: arena.tenantId, kind: 'user_wallet', ownerRef: arena.users[0] ?? '', asset: 'POINTS' });
    if (wallet === undefined) throw new Error('no wallet');
    // Funding already produced three deliveries; this credit is a fourth, tracked on its own.
    const before = new Set((await deliveriesOf()).map((row) => row.id));
    await issuePromoPoints(runtime.db, { tenantId: arena.tenantId, asset: 'POINTS', promoLiabilityAccountId: arena.promo.id, walletAccountId: wallet.id, amount: 5n, idempotencyKey: key('credit') });
    const credit = (await deliveriesOf('wallet.balance.changed')).find((row) => !before.has(row.id));
    if (credit === undefined) throw new Error('no credit delivery');
    expect(credit.payload).toMatchObject({ data: { userId: arena.users[0], asset: 'POINTS', delta: '5', balance: '1005', entryKind: 'issue' } });

    const started = now.getTime();
    const worker = dispatcher();
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      await worker.runOnce();
      const [row] = await runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, credit.id));
      expect(row?.attempt).toBe(attempt);
      expect(row?.responseStatus).toBe(500);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(row?.status).toBe('failed');
        const delay = row === undefined ? 0 : row.nextAttemptAt.getTime() - now.getTime();
        expect(delay).toBe((BACKOFF_SECONDS[attempt - 1] ?? 0) * 1000);
        advance(delay);
      } else {
        expect(row?.status).toBe('dead');
      }
    }
    const elapsedHours = (now.getTime() - started) / 3_600_000;
    expect(elapsedHours).toBeGreaterThan(20);
    expect(elapsedHours).toBeLessThan(26);
    expect(await attemptsOf(credit.id)).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    // Dead is final: nothing more is claimed for it however long we wait.
    advance(7 * 86_400_000);
    const idle = await worker.runOnce();
    expect(idle.claimed).toBe(0);

    // The operator replays it once the receiver is fixed; the receiver sees the event once.
    receiver.mode = 'up';
    const replay = await replayDelivery(runtime.db, { deliveryId: credit.id, actor: OPERATOR });
    expect(replay).toMatchObject({ replayOf: credit.id, eventId: credit.eventId, status: 'pending', attempt: 0, payload: credit.payload });
    expect(await worker.runOnce()).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    expect(receiver.received.map((each) => each.eventId)).toContain(credit.eventId);
    // A replay of the replay names the original, so the chain stays one level deep.
    const again = await replayDelivery(runtime.db, { deliveryId: replay.id, actor: OPERATOR });
    expect(again.replayOf).toBe(credit.id);
  });

  it('a receiver with the wrong secret rejects every attempt as a bad signature, and a stale clock as a replay', async () => {
    receiver.secret = 'whsec_not_the_one_purse_signs_with';
    await queueCredits();
    const worker = dispatcher();
    await worker.runOnce();
    expect(receiver.rejected.length).toBeGreaterThan(0);
    expect(receiver.rejected.every((each) => each.reason === 'signature_mismatch')).toBe(true);
    expect((await deliveriesOf()).every((row) => row.status === 'failed' && row.responseStatus === 401)).toBe(true);

    // The right secret but a receiver whose clock is ten minutes off refuses the timestamp.
    receiver.secret = secret;
    const skewed = new SampleReceiver(secret, () => new Date(now.getTime() + 10 * 60_000));
    const url = await skewed.start();
    try {
      await updateEndpoint(runtime.db, { tenantId: arena.tenantId, endpointId: endpoint.id, url });
      advance((BACKOFF_SECONDS[0] ?? 0) * 1000);
      await worker.runOnce();
      expect(skewed.rejected.length).toBeGreaterThan(0);
      expect(skewed.rejected.every((each) => each.reason === 'timestamp_out_of_window')).toBe(true);
    } finally {
      await skewed.stop();
    }
  });

  it('two dispatchers over the same rows attempt each delivery exactly once, and a disabled endpoint is left alone', async () => {
    receiver.mode = 'hanging';
    const a = dispatcher('test-a');
    const b = dispatcher('test-b');
    const pending = await queueCredits();
    expect(pending.length).toBe(3);
    const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(ra.claimed + rb.claimed).toBe(pending.length);
    for (const row of pending) expect(await attemptsOf(row.id)).toHaveLength(1);
    // The hanging receiver never answered within the timeout: the attempt is a recorded failure, not a hang.
    const rows = await deliveriesOf();
    expect(rows.every((row) => row.status === 'failed' && row.responseStatus === null)).toBe(true);
    for (const row of rows) expect((await attemptsOf(row.id))[0]?.error).toMatch(/Timeout|abort/i);

    await updateEndpoint(runtime.db, { tenantId: arena.tenantId, endpointId: endpoint.id, status: 'disabled' });
    advance(3_600_000);
    expect((await a.runOnce()).claimed).toBe(0);
    await updateEndpoint(runtime.db, { tenantId: arena.tenantId, endpointId: endpoint.id, status: 'enabled' });
    receiver.mode = 'up';
    expect((await a.runOnce()).delivered).toBe(pending.length);
  });

  it('a lease left by a crashed process expires and the delivery is picked up again', async () => {
    receiver.mode = 'up';
    const pending = await queueCredits();
    const first = pending[0];
    if (first === undefined) throw new Error('nothing pending');
    // A process that leased the row and died: the lease is in the future by a minute.
    await migrator.db.update(webhookDeliveries).set({ lockedBy: 'crashed', lockedUntil: new Date(now.getTime() + 60_000) }).where(eq(webhookDeliveries.id, first.id));
    const worker = dispatcher();
    const report = await worker.runOnce();
    expect(report.claimed).toBe(pending.length - 1);
    advance(61_000);
    expect(await worker.runOnce()).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    const [row] = await runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, first.id));
    expect(row).toMatchObject({ status: 'delivered', lockedBy: null, lockedUntil: null });
  });
});
