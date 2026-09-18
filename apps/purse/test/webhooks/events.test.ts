import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES } from '@purse/types';

import { enterContest, transition, voidContest, withdrawEntry } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { webhookDeliveries, type WebhookDelivery } from '../../src/db/schema';
import { devIdentityProvider } from '../../src/providers';
import { addRestriction, startVerification, upsertUser } from '../../src/users';
import { createEndpoint } from '../../src/webhooks';
import { OPERATOR, TENANT_ACTOR, buildArena, makeContest, type Arena } from '../contests/fixtures';
import { connectMigrator, connectRuntime, TEST_KEYS } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';

/**
 * Every event of spec 4.9 is queued by the service that makes the change, in that
 * service's transaction: a refused entry queues nothing, a replayed one queues nothing
 * new, and a tenant with no subscribed endpoint pays nothing.
 */
describe('webhook events at their emit sites', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 2, funding: 500n });
    await createEndpoint(runtime.db, TEST_KEYS, { tenantId: arena.tenantId, url: 'https://events.example/hooks', subscribedEvents: WEBHOOK_EVENT_TYPES });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  async function queued(): Promise<WebhookDelivery[]> {
    return runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, arena.tenantId)).orderBy(asc(webhookDeliveries.id));
  }
  const typesOf = (rows: WebhookDelivery[]): string[] => rows.map((row) => row.eventType);

  it('a contest lifecycle: opened, entry created, entry withdrawn, locked, voided, with the wallet moves', async () => {
    const [ana, marcus] = arena.users;
    if (ana === undefined || marcus === undefined) throw new Error('two users');
    const contest = await makeContest(runtime.db, arena, { entryAmount: 50n });
    expect(await queued()).toEqual([]);

    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR });
    expect(typesOf(await queued())).toEqual(['contest.opened']);
    expect((await queued())[0]?.payload).toMatchObject({ type: 'contest.opened', data: { contestId: contest.id, externalId: contest.externalId, state: 'open', previousState: 'draft', kind: 'tournament', asset: 'POINTS', settledAt: null } });

    const k = key('enter');
    const entered = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: ana, teamRef: 'team-a', idempotencyKey: k, actor: TENANT_ACTOR });
    let rows = await queued();
    expect(typesOf(rows).slice(1).sort()).toEqual(['contest.entry.created', 'wallet.balance.changed']);
    const entry = rows.find((row) => row.eventType === 'contest.entry.created');
    expect(entry?.payload).toMatchObject({ data: { contestId: contest.id, userId: ana, participantId: entered.participant.id, teamRef: 'team-a', journalEntryId: entered.entry.entry.id, rulesetVersion: '2026.09.1', reentered: false } });
    const move = rows.find((row) => row.eventType === 'wallet.balance.changed');
    expect(move?.payload).toMatchObject({ data: { userId: ana, asset: 'POINTS', delta: '-50', balance: '450', entryKind: 'escrow', contestId: contest.id, journalEntryId: entered.entry.entry.id } });

    // A replay of the same entry queues nothing new.
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: ana, teamRef: 'team-a', idempotencyKey: k, actor: TENANT_ACTOR });
    expect(await queued()).toHaveLength(3);

    // A refused entry (a self-excluded user) queues nothing: its transaction rolled back.
    // The exclusion starts a minute ago: a `now()` start could be microseconds ahead of the
    // millisecond `asOf` the entry is judged at.
    const excluded = await upsertUser(runtime.db, { tenantId: arena.tenantId, externalId: 'excluded', displayName: 'X', dateOfBirth: '1990-01-01' });
    await addRestriction(runtime.db, { tenantId: arena.tenantId, userId: excluded.user.id, kind: 'self_exclusion', startsAt: new Date(Date.now() - 60_000), actor: { kind: 'user', ref: excluded.user.id } });
    await expect(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: excluded.user.id, idempotencyKey: key('refused'), actor: TENANT_ACTOR })).rejects.toMatchObject({ code: 'not_eligible' });
    expect(await queued()).toHaveLength(3);

    await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: ana, idempotencyKey: key('withdraw'), actor: TENANT_ACTOR });
    rows = await queued();
    expect(typesOf(rows).slice(3).sort()).toEqual(['contest.entry.withdrawn', 'wallet.balance.changed']);
    expect(rows.find((row) => row.eventType === 'contest.entry.withdrawn')?.payload).toMatchObject({ data: { contestId: contest.id, userId: ana, participantId: entered.participant.id } });
    expect(rows.find((row) => row.eventType === 'wallet.balance.changed' && (row.payload as { data: { entryKind: string } }).data.entryKind === 'refund')?.payload).toMatchObject({
      data: { userId: ana, delta: '50', balance: '500', entryKind: 'refund' },
    });

    // Re-entry is reported as such; then lock and void refund the stake.
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: ana, idempotencyKey: key('again'), actor: TENANT_ACTOR });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: marcus, idempotencyKey: key('marcus'), actor: TENANT_ACTOR });
    rows = await queued();
    expect(rows.find((row) => row.eventType === 'contest.entry.created' && (row.payload as { data: { reentered: boolean } }).data.reentered)?.payload).toMatchObject({ data: { userId: ana, reentered: true } });
    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'locked', actor: OPERATOR });
    expect(typesOf(await queued()).at(-1)).toBe('contest.locked');
    await voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: key('void') });
    rows = await queued();
    expect(typesOf(rows).at(-1)).toBe('contest.voided');
    expect(rows.filter((row) => row.eventType === 'wallet.balance.changed' && (row.payload as { data: { entryKind: string } }).data.entryKind === 'void')).toHaveLength(2);
    expect(rows.every((row) => row.status === 'pending' && row.attempt === 0)).toBe(true);
    // One event id per happening, shared by nothing else.
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(rows.length);
  });

  it('verification: one event when the check starts, one when the provider decides', async () => {
    const identity = devIdentityProvider({ allow: [], deny: ['no'], pending: [] });
    const user = await upsertUser(runtime.db, { tenantId: arena.tenantId, externalId: 'yes', displayName: 'Y', dateOfBirth: '1990-01-01' });
    const started = await startVerification(runtime.db, { tenantId: arena.tenantId, userId: user.user.id, identity, actor: TENANT_ACTOR });
    expect(started.verification.state).toBe('verified');
    const rows = (await queued()).filter((row) => row.eventType === 'user.verification.updated');
    expect(rows.map((row) => (row.payload as { data: { previousState: string; verification: { state: string } } }).data)).toMatchObject([
      { previousState: 'unstarted', verification: { state: 'pending' } },
      { previousState: 'pending', verification: { state: 'verified', provider: 'dev' } },
    ]);
    expect(rows[0]?.payload).toMatchObject({ data: { userId: user.user.id, externalId: 'yes' } });
    const denied = await upsertUser(runtime.db, { tenantId: arena.tenantId, externalId: 'no', displayName: 'N', dateOfBirth: '1990-01-01' });
    await startVerification(runtime.db, { tenantId: arena.tenantId, userId: denied.user.id, identity, actor: TENANT_ACTOR });
    const deniedRows = (await queued()).filter((row) => row.eventType === 'user.verification.updated' && (row.payload as { data: { userId: string } }).data.userId === denied.user.id);
    expect(deniedRows.map((row) => (row.payload as { data: { verification: { state: string } } }).data.verification.state)).toEqual(['pending', 'rejected']);
  });

  it('a tenant with no subscribed endpoint queues nothing, and another tenant hears nothing of this one', async () => {
    const other = await buildArena(runtime.db, { users: 1, funding: 100n });
    await createEndpoint(runtime.db, TEST_KEYS, { tenantId: other.tenantId, url: 'https://other.example/hooks', subscribedEvents: ['contest.opened'] });
    const contest = await makeContest(runtime.db, other);
    await transition(runtime.db, { tenantId: other.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR });
    await transition(runtime.db, { tenantId: other.tenantId, contestId: contest.id, to: 'locked', actor: OPERATOR });
    const theirs = await runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, other.tenantId));
    expect(typesOf(theirs)).toEqual(['contest.opened']);
    expect(await queued()).toEqual([]);
  });
});
