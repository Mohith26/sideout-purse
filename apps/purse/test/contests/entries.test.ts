import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { enterContest, listParticipants, transition, voidContest, withdrawEntry } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { auditLog, contestParticipants, journalEntries } from '../../src/db/schema';
import { reconcile } from '../../src/ledger';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, contestError, escrowOf, ledgerError, makeContest, OPERATOR, TENANT_ACTOR, walletBalance, type Arena } from './fixtures';

/**
 * Spec 4.2.5 "Enter a contest" and "Refund a withdrawal before lock", 4.1
 * `contest_participants`, and the double-entry concurrency case from section 8.
 */
describe('enterContest()', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 16 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 3, funding: 250n });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? newId('usr');

  it('escrows the entry amount, records the participant with its entry link, and audits it', async () => {
    const contest = await makeContest(runtime.db, arena, { entryAmount: 100n });
    await advance(runtime.db, arena, contest.id, 'open');
    const k = key('enter');
    const entered = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, idempotencyKey: k, actor: TENANT_ACTOR });

    expect(entered.replayed).toBe(false);
    expect(entered.participant).toMatchObject({ contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, state: 'entered', entryJournalEntryId: entered.entry.entry.id });
    expect(entered.participant.id).toMatch(/^ent_/);
    expect(entered.entry.entry).toMatchObject({ kind: 'escrow', contestId: contest.id, idempotencyKey: `contest-entry:${k}` });
    expect(entered.entry.lines.map((l) => [l.direction, l.amount])).toEqual([
      ['debit', 100n],
      ['credit', 100n],
    ]);
    expect(entered.eligibility).toEqual({ allowed: true, rulesetVersion: 'allow-all.phase-2' });
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(150n);
    expect(await escrowOf(runtime.db, contest)).toBe(100n);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, entered.participant.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'contest.entry.created', actorKind: 'tenant', before: null });
    expect(audit[0]?.after).toMatchObject({ userId: user(0), rulesetVersion: 'allow-all.phase-2' });

    // I7 holds for this participant.
    const report = await reconcile(runtime.db);
    expect(report.invariants.find((r) => r.id === 'I7')).toMatchObject({ ok: true, detail: 'every one of 1 participants links to a matching escrow entry' });
  });

  it('is idempotent by key: a replay returns the same participant and entry and creates nothing', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    const k = key('enter');
    const input = { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: k };
    const first = await enterContest(runtime.db, input);
    const again = await enterContest(runtime.db, input);
    expect(again.replayed).toBe(true);
    expect(again.participant).toEqual(first.participant);
    expect(again.entry.entry.id).toBe(first.entry.entry.id);
    expect(again.entry.lines).toEqual(first.entry.lines);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(150n);
    const [participants] = await runtime.db.select({ n: count() }).from(contestParticipants);
    expect(participants?.n).toBe(1);

    const conflict = await contestError(enterContest(runtime.db, { ...input, userId: user(1) }));
    expect(conflict.code).toBe('idempotency_conflict');
    expect(conflict.apiType).toBe('conflict');
  });

  it('refuses a second entry by the same user, and under concurrency exactly one succeeds', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    const twice = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() }));
    expect(twice.code).toBe('already_entered');
    expect(twice.apiType).toBe('conflict');
    expect(twice.detail).toMatchObject({ participantState: 'entered' });

    // The unique constraint stands behind the service: even the owner cannot insert a second row.
    const [row] = await runtime.db.select().from(contestParticipants).where(eq(contestParticipants.userId, user(0)));
    const raw = await rejection(
      migrator.db.insert(contestParticipants).values({ id: newId('ent'), contestId: contest.id, userId: user(0), entryJournalEntryId: row?.entryJournalEntryId ?? '' }),
    );
    expect(String((raw as Error).cause)).toMatch(/contest_participants_contest_id_user_id_key|contest_participants_entry_journal_entry_id_key/);

    // Simultaneous double entries by one user: one wins, the rest are refused, one stake is held.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(1), idempotencyKey: key('dbl') })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'already_entered' });
    expect(await walletBalance(runtime.db, arena, user(1))).toBe(150n);
    expect(await escrowOf(runtime.db, contest)).toBe(200n);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('a withdrawn entrant re-enters: the same row is reactivated with a fresh escrow entry, and a void refunds that one', async () => {
    const contest = await makeContest(runtime.db, arena, { entryAmount: 100n });
    await advance(runtime.db, arena, contest.id, 'open');
    const first = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, idempotencyKey: key() });
    const withdrawn = await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    expect(withdrawn.participant.state).toBe('withdrawn');
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(250n);

    // Back in, but only with the team and seed of the first entry.
    const changed = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-b', seed: 2, idempotencyKey: key() }));
    expect(changed.code).toBe('invalid_input');
    expect(changed.detail).toMatchObject({ participantId: first.participant.id, teamRef: 'team-a', seed: 2 });
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(250n);

    const k = key('reenter');
    const again = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, idempotencyKey: k, actor: TENANT_ACTOR });
    expect(again.replayed).toBe(false);
    expect(again.participant.id).toBe(first.participant.id);
    expect(again.participant).toMatchObject({ state: 'entered', teamRef: 'team-a', seed: 2, joinedAt: first.participant.joinedAt, entryJournalEntryId: again.entry.entry.id });
    expect(again.entry.entry.id).not.toBe(first.entry.entry.id);
    expect(again.entry.entry).toMatchObject({ kind: 'escrow', contestId: contest.id, idempotencyKey: `contest-entry:${k}` });
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(150n);
    expect(await escrowOf(runtime.db, contest)).toBe(100n);
    expect(await listParticipants(runtime.db, contest.id)).toHaveLength(1);
    // The first entry stays what it was: refunded, not reversed.
    const [original] = await runtime.db.select().from(journalEntries).where(eq(journalEntries.id, first.entry.entry.id));
    expect(original?.kind).toBe('escrow');
    expect(await runtime.db.select().from(journalEntries).where(eq(journalEntries.reversesEntryId, first.entry.entry.id))).toEqual([]);

    const replay = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, idempotencyKey: k });
    expect(replay.replayed).toBe(true);
    expect(replay.entry.entry.id).toBe(again.entry.entry.id);
    const third = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, idempotencyKey: key() }));
    expect(third.code).toBe('already_entered');
    expect(third.detail).toMatchObject({ participantState: 'entered' });

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, first.participant.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['contest.entry.created', 'contest.entry.withdrawn', 'contest.entry.reentered']);
    expect(audit[2]).toMatchObject({ actorKind: 'tenant' });
    expect(audit[2]?.before).toMatchObject({ state: 'withdrawn', entryJournalEntryId: first.entry.entry.id });
    expect(audit[2]?.after).toMatchObject({ state: 'entered', entryJournalEntryId: again.entry.entry.id });

    let report = await reconcile(runtime.db);
    expect(report.invariants.find((r) => r.id === 'I7')).toMatchObject({ ok: true, detail: 'every one of 1 participants links to a matching escrow entry' });

    // Leaving and coming back again works the same way; the void then reverses the entry that holds the stake now.
    await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    const back = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), teamRef: 'team-a', seed: 2, idempotencyKey: key() });
    expect(back.participant.id).toBe(first.participant.id);
    const voided = await voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: key() });
    expect(voided.refunds.map((refund) => refund.entry.reversesEntryId)).toEqual([back.entry.entry.id]);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(250n);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok)).toEqual([]);
  });

  it('refuses entries while not open, after locks_at, when full, and without funds, moving nothing', async () => {
    const draft = await makeContest(runtime.db, arena, { maxParticipants: 1 });
    const notOpen = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: draft.id, userId: user(0), idempotencyKey: key() }));
    expect(notOpen.code).toBe('contest_not_open');
    expect(notOpen.apiType).toBe('not_eligible');
    expect(notOpen.detail).toMatchObject({ reasons: ['contest_not_open'], state: 'draft' });

    await advance(runtime.db, arena, draft.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: draft.id, userId: user(0), idempotencyKey: key() });
    const full = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: draft.id, userId: user(1), idempotencyKey: key() }));
    expect(full.code).toBe('contest_full');
    expect(full.detail).toMatchObject({ reasons: ['contest_full'], maxParticipants: 1 });

    const timed = await makeContest(runtime.db, arena, { locksAt: new Date('2026-09-17T12:00:00Z') });
    await advance(runtime.db, arena, timed.id, 'open');
    const early = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: timed.id, userId: user(0), idempotencyKey: key(), now: new Date('2026-09-17T11:59:59Z') });
    expect(early.participant.state).toBe('entered');
    const late = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: timed.id, userId: user(1), idempotencyKey: key(), now: new Date('2026-09-17T12:00:00Z') }));
    expect(late.code).toBe('contest_not_open');
    expect(late.detail).toMatchObject({ locksAt: '2026-09-17T12:00:00.000Z' });

    // Funds: 250 minus two entries of 100 leaves 50, not enough for a third.
    const third = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, third.id, 'open');
    const broke = await ledgerError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: third.id, userId: user(0), idempotencyKey: key() }));
    expect(broke.code).toBe('insufficient_funds');
    expect(broke.detail).toMatchObject({ balance: '50', requested: '100' });
    // A user with no wallet at all is refused the same way, and no wallet or participant row is left behind.
    const stranger = newId('usr');
    const nothing = await ledgerError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: third.id, userId: stranger, idempotencyKey: key() }));
    expect(nothing.code).toBe('insufficient_funds');
    expect(await walletBalance(runtime.db, arena, stranger)).toBe(0n);
    expect(await listParticipants(runtime.db, third.id)).toEqual([]);
    expect(await escrowOf(runtime.db, third)).toBe(0n);

    const bad = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: third.id, userId: 'someone', idempotencyKey: key() }));
    expect(bad.code).toBe('invalid_input');
    const badSeed = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: third.id, userId: user(2), seed: 0, idempotencyKey: key() }));
    expect(badSeed.code).toBe('invalid_input');
  });

  it('never touches another tenant’s contest', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    const other = await buildArena(runtime.db, { users: 1 });
    const error = await contestError(enterContest(runtime.db, { tenantId: other.tenantId, contestId: contest.id, userId: other.users[0] ?? newId('usr'), idempotencyKey: key() }));
    expect(error.code).toBe('contest_wrong_tenant');
  });
});

describe('withdrawEntry()', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 8 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 2, funding: 300n });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? newId('usr');

  it('refunds the stake with a refund entry (not a reversal), marks the participant withdrawn, and replays idempotently', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(1), idempotencyKey: key() });

    const k = key('withdraw');
    const withdrawn = await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: k, actor: TENANT_ACTOR });
    expect(withdrawn.replayed).toBe(false);
    expect(withdrawn.participant.state).toBe('withdrawn');
    expect(withdrawn.refund.entry).toMatchObject({ kind: 'refund', reversesEntryId: null, contestId: contest.id, idempotencyKey: `contest-withdraw:${k}` });
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(300n);
    expect(await escrowOf(runtime.db, contest)).toBe(100n);

    const again = await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: k });
    expect(again.replayed).toBe(true);
    expect(again.refund.entry.id).toBe(withdrawn.refund.entry.id);
    expect(again.participant).toEqual(withdrawn.participant);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(300n);

    const twice = await contestError(withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() }));
    expect(twice.code).toBe('participant_not_active');
    const never = await contestError(withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: newId('usr'), idempotencyKey: key() }));
    expect(never.code).toBe('not_a_participant');

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, withdrawn.participant.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['contest.entry.created', 'contest.entry.withdrawn']);
    expect(audit[1]?.before).toMatchObject({ state: 'entered' });
    expect(audit[1]?.after).toMatchObject({ state: 'withdrawn', refundEntryId: withdrawn.refund.entry.id });
    const [entries] = await runtime.db.select({ n: count() }).from(journalEntries);
    // 2 fundings, 2 entries, 1 refund.
    expect(entries?.n).toBe(5);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('is refused once the contest is locked: the stake stays in escrow until settlement or void', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'locked', actor: OPERATOR });
    const error = await contestError(withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() }));
    expect(error.code).toBe('invalid_contest_state');
    expect(error.detail).toMatchObject({ state: 'locked', expected: 'open' });
    expect(await escrowOf(runtime.db, contest)).toBe(100n);
  });

  it('is refused once locks_at has passed, on the same clock as entry, even before the operator locks the contest', async () => {
    const contest = await makeContest(runtime.db, arena, { locksAt: new Date('2026-09-17T12:00:00Z') });
    await advance(runtime.db, arena, contest.id, 'open');
    const early = new Date('2026-09-17T11:59:59Z');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key(), now: early });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(1), idempotencyKey: key(), now: early });

    const late = await contestError(withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key(), now: new Date('2026-09-17T12:00:00Z') }));
    expect(late.code).toBe('invalid_contest_state');
    expect(late.detail).toMatchObject({ state: 'open', locksAt: '2026-09-17T12:00:00.000Z', expected: 'open' });
    expect(await escrowOf(runtime.db, contest)).toBe(200n);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(200n);

    const inTime = await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(1), idempotencyKey: key(), now: early });
    expect(inTime.participant.state).toBe('withdrawn');
    expect(await escrowOf(runtime.db, contest)).toBe(100n);
    expect(await walletBalance(runtime.db, arena, user(1))).toBe(300n);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('the participant row’s identity cannot change, and its state and entry link move only as the guard allows', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    const { participant, entry } = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    const other = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(1), idempotencyKey: key() });

    // The entry link moves only with a withdrawn -> entered reactivation, for every role.
    const link = await rejection(runtime.sql`update contest_participants set entry_journal_entry_id = ${other.entry.entry.id} where id = ${participant.id}`);
    expect(String(link)).toMatch(/entry link changes exactly when a withdrawn entrant re-enters/);
    const seed = await rejection(runtime.sql`update contest_participants set seed = 1 where id = ${participant.id}`);
    expect(String(seed)).toMatch(/permission denied for table contest_participants/);
    const owner = await rejection(migrator.sql`update contest_participants set user_id = ${newId('usr')} where id = ${participant.id}`);
    expect(String(owner)).toMatch(/identity fields cannot change/);

    await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    // Back to entered without a new stake is refused; with one it is admitted, so the row always names the entry holding the stake.
    const noStake = await rejection(migrator.sql`update contest_participants set state = 'entered' where id = ${participant.id}`);
    expect(String(noStake)).toMatch(/entry link changes exactly when a withdrawn entrant re-enters/);
    const dq = await rejection(migrator.sql`update contest_participants set state = 'disqualified' where id = ${participant.id}`);
    expect(String(dq)).toMatch(/cannot move from withdrawn to disqualified/);
    const [row] = await runtime.db.select().from(contestParticipants).where(eq(contestParticipants.id, participant.id));
    expect(row).toMatchObject({ state: 'withdrawn', entryJournalEntryId: entry.entry.id });
  });
});
