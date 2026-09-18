import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { closeContest, enterContest, getContest, isContestError, previewSettlement, submitScores, voidContest, type ClosedContest } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { auditLog, contestResults, journalEntries } from '../../src/db/schema';
import { findAccount, reconcile } from '../../src/ledger';
import { connectMigrator, connectRuntime } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, escrowOf, inProgress, makeContest, OPERATOR, score, TENANT_ACTOR, walletBalance, type Arena } from './fixtures';

/**
 * Phase 2's exit criterion and spec section 8 "Concurrency": N simultaneous closes produce
 * exactly one settlement with escrow at zero; simultaneous double entries by one user
 * admit one; a close with a stale hash after a late score is rejected.
 */
const N = 25;

describe('concurrent close', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 32 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 5 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it(`${N} simultaneous closes with a valid hash: exactly one settlement, one results set, escrow exactly zero`, async () => {
    const contest = await inProgress(runtime.db, arena, { prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] } });
    await score(runtime.db, arena, contest.id, [5, 4, 3, 2, 1]);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key(`close-${i}`) }),
      ),
    );
    const settled = results.filter((r): r is PromiseFulfilledResult<ClosedContest> => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(settled).toHaveLength(1);
    expect(refused).toHaveLength(N - 1);
    for (const r of refused) {
      expect(isContestError(r.reason, 'already_settled'), String(r.reason)).toBe(true);
    }
    expect(settled[0]?.value.replayed).toBe(false);

    // Exactly one settlement, one results set, escrow exactly zero.
    const [settleEntries] = await runtime.db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.kind, 'settle'));
    expect(settleEntries?.n).toBe(1);
    const [rows] = await runtime.db.select({ n: count() }).from(contestResults).where(eq(contestResults.contestId, contest.id));
    expect(rows?.n).toBe(5);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    expect(await walletBalance(runtime.db, arena, arena.users[0] ?? newId('usr'))).toBe(1150n);
    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id));
    expect(audit.filter((row) => row.action === 'contest.settling')).toHaveLength(1);
    expect(audit.filter((row) => row.action === 'contest.settled')).toHaveLength(1);
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('settled');

    const report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok)).toEqual([]);
  });

  it(`${N} simultaneous closes under one idempotency key: one settlement, every caller handed the same result`, async () => {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [5, 4, 3, 2, 1]);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    const k = key('same-close');
    const results = await Promise.all(
      Array.from({ length: N }, () => closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: k })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.entry?.entry.id));
    expect(ids.size).toBe(1);
    for (const r of results) {
      expect(r.payoutHash).toBe(preview.payoutHash);
      expect(r.results.map((row) => row.id)).toEqual(results[0]?.results.map((row) => row.id));
    }
    const [settleEntries] = await runtime.db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.kind, 'settle'));
    expect(settleEntries?.n).toBe(1);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
  });

  it('a close racing a void: one of them wins and the other is refused; escrow is zero either way', async () => {
    const contest = await inProgress(runtime.db, arena, { settlementPolicy: 'auto' });
    await score(runtime.db, arena, contest.id, [1, 2, 3, 4], { users: arena.users.slice(0, 4) });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 8 }, () => closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key('c') })),
      ...Array.from({ length: 8 }, () => voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: key('v') })),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const final = await getContest(runtime.db, arena.tenantId, contest.id);
    expect(['settled', 'voided']).toContain(final.state);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    const report = await reconcile(runtime.db);
    expect(report.ok).toBe(true);
  });

  it('a void takes its wallet locks in id order up front, so it waits behind a settlement holding the same wallets instead of deadlocking', async () => {
    const [first, second] = arena.users;
    if (first === undefined || second === undefined) throw new Error('two users are needed');
    const wallets = [
      await findAccount(runtime.db, { tenantId: arena.tenantId, kind: 'user_wallet', ownerRef: first, asset: arena.asset }),
      await findAccount(runtime.db, { tenantId: arena.tenantId, kind: 'user_wallet', ownerRef: second, asset: arena.asset }),
    ].sort((a, b) => ((a?.id ?? '') < (b?.id ?? '') ? -1 : 1));
    const [low, high] = wallets;
    if (low === undefined || high === undefined) throw new Error('both wallets exist');

    // The owner of the higher-sorting wallet joins first: a void refunding in join order would lock high, then low.
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: high.ownerRef ?? '', idempotencyKey: key() });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: low.ownerRef ?? '', idempotencyKey: key() });

    const someoneWaits = async () => {
      const [row] = await runtime.sql<Array<{ n: number }>>`select count(*)::int as n from pg_locks where not granted`;
      return (row?.n ?? 0) > 0;
    };

    // Stand in for another contest's settlement paying both wallets: one sorted FOR UPDATE
    // takes low first, so it holds low while the void runs, then asks for high. The void's
    // promise is handed out unawaited: it can only finish once this transaction commits.
    const { pending } = await runtime.sql.begin(async (tx) => {
      await tx`select id from accounts where id = ${low.id} for update`;
      const voiding = voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: key('void') });
      const deadline = Date.now() + 10_000;
      while (!(await someoneWaits())) {
        if (Date.now() > deadline) throw new Error('the void never blocked on the low wallet');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The void is queued on low and holds no other wallet, so high is free: this returns
      // rather than closing a cycle that Postgres would break with a deadlock error.
      await tx`select id from accounts where id = ${high.id} for update`;
      return { pending: voiding };
    });

    const voided = await pending;
    expect(voided.replayed).toBe(false);
    expect(voided.contest.state).toBe('voided');
    expect(voided.refunds).toHaveLength(2);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    expect(await walletBalance(runtime.db, arena, first)).toBe(1000n);
    expect(await walletBalance(runtime.db, arena, second)).toBe(1000n);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });
});

describe('concurrent entries and late scores', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 32 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 3, funding: 5000n });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it(`${N} simultaneous entries by one user: one succeeds, one stake is escrowed`, async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    const userId = arena.users[0] ?? newId('usr');
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId, idempotencyKey: key(`enter-${i}`), actor: TENANT_ACTOR })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(isContestError(r.reason, 'already_entered'), String(r.reason)).toBe(true);
    }
    expect(await walletBalance(runtime.db, arena, userId)).toBe(4900n);
    expect(await escrowOf(runtime.db, contest)).toBe(100n);
    const [escrows] = await runtime.db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.kind, 'escrow'));
    expect(escrows?.n).toBe(1);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('a capped contest under simultaneous entries by different users admits exactly the cap', async () => {
    const arenaOfMany = await buildArena(runtime.db, { users: 12, funding: 200n });
    const contest = await makeContest(runtime.db, arenaOfMany, { maxParticipants: 4 });
    await advance(runtime.db, arenaOfMany, contest.id, 'open');
    const results = await Promise.allSettled(
      arenaOfMany.users.map((userId) => enterContest(runtime.db, { tenantId: arenaOfMany.tenantId, contestId: contest.id, userId, idempotencyKey: key('cap') })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    for (const r of results) if (r.status === 'rejected') expect(isContestError(r.reason, 'contest_full')).toBe(true);
    expect(await escrowOf(runtime.db, contest)).toBe(400n);
  });

  it('a close with a stale hash after a late score is rejected, even when the close and the score race', async () => {
    const contest = await inProgress(runtime.db, arena);
    // Two unfinished attempts; the operator moves the contest on regardless.
    await score(runtime.db, arena, contest.id, [10, 9], { users: arena.users.slice(0, 2), finished: false });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const stale = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });

    // Sequential: the late score lands, then the close with the old hash is refused.
    await submitScores(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, scores: [{ userId: arena.users[2] ?? newId('usr'), score: 50, attemptFinished: true }], idempotencyKey: key() });
    await expect(closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: stale.payoutHash, actor: OPERATOR, idempotencyKey: key() })).rejects.toMatchObject({ code: 'preview_hash_mismatch' });
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('awaiting_settlement');

    // Racing: a fresh preview, then a correcting score for an unfinished attempt and a close
    // fired together. Whichever wins the row lock the outcome is consistent: the close
    // settled on the fresh hash and the score is then refused, or the score landed first and
    // the close is refused as stale. Never a settlement on inputs the preview did not show.
    const second = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    const late = submitScores(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, scores: [{ userId: arena.users[0] ?? newId('usr'), score: 1, attemptFinished: true }], idempotencyKey: key() });
    const close = closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: second.payoutHash, actor: OPERATOR, idempotencyKey: key() });
    const [lateOutcome, closeOutcome] = await Promise.allSettled([late, close]);
    const final = await getContest(runtime.db, arena.tenantId, contest.id);
    if (closeOutcome.status === 'fulfilled') {
      expect(final.state).toBe('settled');
      expect(closeOutcome.value.payoutHash).toBe(second.payoutHash);
      expect(lateOutcome.status).toBe('rejected');
      if (lateOutcome.status === 'rejected') expect(isContestError(lateOutcome.reason, 'scores_not_accepted'), String(lateOutcome.reason)).toBe(true);
    } else {
      expect(isContestError(closeOutcome.reason, 'preview_hash_mismatch'), String(closeOutcome.reason)).toBe(true);
      expect(lateOutcome.status).toBe('fulfilled');
      expect(final.state).toBe('awaiting_settlement');
      expect(await escrowOf(runtime.db, contest)).toBe(300n);
    }
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });
});
