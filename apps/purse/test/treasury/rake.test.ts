import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeContest, previewSettlement, submitScores } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { contests } from '../../src/db/schema';
import { balanceOf, openAccount, reconcile } from '../../src/ledger';
import { applyBps } from '../../src/treasury';
import { advance, buildArena, inProgress, OPERATOR, scoresFor, TENANT_ACTOR, type Arena } from '../contests/fixtures';
import { connectMigrator, connectRuntime } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';

/**
 * The platform's rake (spec 13.3).
 *
 * The claim being tested is not "a fee is taken" but "taking a fee leaves every existing
 * invariant true". The rake is posted as its own `fee` entry immediately before the
 * settlement, which is what lets I4 still find an empty escrow and I5 still find payouts
 * equal to what the contest escrowed, with no amendment to either.
 */
describe('treasury: the rake', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });

  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 4, funding: 10_000n });
  });

  async function feeBalance(): Promise<bigint> {
    const { account } = await openAccount(runtime.db, { tenantId: arena.tenantId, kind: 'platform_fee', ownerRef: null, asset: arena.asset });
    return balanceOf(runtime.db, account.id);
  }

  /** Enter everyone, score them, then close through the frozen preview. */
  async function playAndClose(overrides: { entryAmount: bigint; rakeBps: number; winnerTakeAll?: boolean }, values: number[]) {
    const contest = await inProgress(runtime.db, arena, {
      entryAmount: overrides.entryAmount,
      rakeBps: overrides.rakeBps,
      ...(overrides.winnerTakeAll === true ? { prizeStructure: { type: 'winner_take_all' as const } } : {}),
    });
    await submitScores(runtime.db, {
      tenantId: arena.tenantId,
      contestId: contest.id,
      scores: scoresFor(arena.users, values),
      idempotencyKey: key('score'),
      actor: TENANT_ACTOR,
    });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    const closed = await closeContest(runtime.db, {
      tenantId: arena.tenantId,
      contestId: contest.id,
      payoutHash: preview.payoutHash,
      actor: OPERATOR,
      idempotencyKey: key('close'),
    });
    return { contest, preview, closed };
  }

  it('takes the rake off the top and pays out only the net pool', async () => {
    // Four entrants at 1,000 each: a 4,000 pot, 5% rake, 3,800 to the winner.
    const { contest, preview, closed } = await playAndClose({ entryAmount: 1_000n, rakeBps: 500, winnerTakeAll: true }, [40, 30, 20, 10]);

    expect(preview.escrowTotal).toBe(4_000n);
    expect(preview.rakeAmount).toBe(200n);
    expect(preview.netPool).toBe(3_800n);
    expect(closed.payouts.reduce((sum, payout) => sum + payout.payout, 0n)).toBe(3_800n);
    expect(closed.rake?.entry.kind).toBe('fee');
    expect(await feeBalance()).toBe(200n);
    // The escrow is empty: gross, less rake, less payouts, leaves nothing.
    expect(await balanceOf(runtime.db, contest.escrowAccountId)).toBe(0n);
  });

  it('leaves every pre-existing invariant true', async () => {
    await playAndClose({ entryAmount: 2_500n, rakeBps: 250 }, [9, 7, 5, 1]);

    const report = await reconcile(runtime.db);
    expect(report.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.id)).toEqual([]);
    expect(report.ok).toBe(true);
    // Named explicitly: these are the three the rake could plausibly have broken.
    expect(report.invariants.find((invariant) => invariant.id === 'I4')?.ok).toBe(true);
    expect(report.invariants.find((invariant) => invariant.id === 'I5')?.ok).toBe(true);
    expect(report.invariants.find((invariant) => invariant.id === 'I9')?.ok).toBe(true);
  });

  it('a free-to-play contest takes nothing and posts no fee entry', async () => {
    const { closed } = await playAndClose({ entryAmount: 100n, rakeBps: 0 }, [7, 5, 3, 1]);

    expect(closed.rake).toBeNull();
    expect(await feeBalance()).toBe(0n);
    expect(closed.payouts.reduce((sum, payout) => sum + payout.payout, 0n)).toBe(400n);
    const fees = await runtime.db.execute<{ n: string }>(sql`select count(*)::text as n from journal_entries where kind = 'fee'`);
    expect(fees[0]?.n).toBe('0');
  });

  it('rounds the rake down, so the remainder stays with the players', async () => {
    // 4 x 333 = 1,332 at 333 bps is 44.3556, which must floor to 44 and never 45.
    expect(applyBps(1_332n, 333)).toBe(44n);

    const { preview, closed } = await playAndClose({ entryAmount: 333n, rakeBps: 333 }, [4, 3, 2, 1]);

    expect(preview.rakeAmount).toBe(44n);
    expect(await feeBalance()).toBe(44n);
    expect(closed.payouts.reduce((sum, payout) => sum + payout.payout, 0n)).toBe(1_288n);
  });

  it('the rake a contest settled under is frozen, even if the column changes afterwards', async () => {
    const { contest } = await playAndClose({ entryAmount: 1_000n, rakeBps: 1_000 }, [4, 3, 2, 1]);
    expect(await feeBalance()).toBe(400n);

    // Change the rate after the fact. The recorded settlement must not move.
    await migrator.db.update(contests).set({ rakeBps: 4_000 }).where(eq(contests.id, contest.id));

    const replayed = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(replayed.rakeAmount).toBe(400n);
    expect(await feeBalance()).toBe(400n);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('the database refuses a rake over half the pool', async () => {
    const contest = await inProgress(runtime.db, arena, { entryAmount: 100n });
    const refused = await migrator.sql`
      update contests set rake_bps = 9000 where id = ${contest.id}
    `.then(() => undefined, (error: unknown) => String(error));
    expect(refused).toMatch(/contests_rake_bps_range/);
  });
});
