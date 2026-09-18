import { count } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../src/db/client';
import { journalEntries } from '../../src/db/schema';
import { balanceOf, escrowEntry, isLedgerError, issuePromoPoints, reconcile } from '../../src/ledger';
import { connectMigrator, connectRuntime } from '../helpers';
import { buildWorld, key, wipeLedger, type World } from './fixtures';

/**
 * Spec section 8, "Concurrency": simultaneous debits against one wallet. The wallet row
 * lock plus the derived-balance check inside the same transaction means exactly as many
 * succeed as the balance covers, whatever the interleaving.
 */
describe('concurrent posts against one wallet', () => {
  let migrator: Database;
  let runtime: Database;
  let world: World;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 16 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    world = await buildWorld(runtime.db, { wallets: 1, escrows: 2 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('50 simultaneous escrow entries against a wallet that covers 10: exactly 10 succeed and the wallet lands on zero', async () => {
    const wallet = world.wallets[0]?.id ?? '';
    const escrow = world.escrows[0]?.id ?? '';
    await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet, amount: 100n, idempotencyKey: key() });

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet, escrowAccountId: escrow, amount: 10n, idempotencyKey: key(`c${i}`) }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(refused).toHaveLength(40);
    for (const r of refused) expect(isLedgerError(r.reason, 'insufficient_funds')).toBe(true);

    expect(await balanceOf(runtime.db, wallet)).toBe(0n);
    expect(await balanceOf(runtime.db, escrow)).toBe(100n);
    const [rows] = await runtime.db.select({ n: count() }).from(journalEntries);
    expect(rows?.n).toBe(11);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('the same request fired concurrently under one key posts once and every caller gets that entry', async () => {
    const wallet = world.wallets[0]?.id ?? '';
    const k = key('same');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet, amount: 7n, idempotencyKey: k }),
      ),
    );
    const ids = new Set(results.map((r) => r.entry.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balanceOf(runtime.db, wallet)).toBe(7n);
  });

  it('posts that cross two accounts in opposite orders do not deadlock', async () => {
    // Every post locks its accounts in id order, so A->B and B->A entries wait on each
    // other rather than deadlocking, and all of them land.
    const wallet = world.wallets[0]?.id ?? '';
    const [e1, e2] = world.escrows.map((a) => a.id);
    await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet, amount: 10_000n, idempotencyKey: key() });
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        escrowEntry(runtime.db, {
          tenantId: world.tenantId,
          asset: 'POINTS',
          walletAccountId: wallet,
          escrowAccountId: (i % 2 === 0 ? e1 : e2) ?? '',
          amount: 1n,
          idempotencyKey: key(`x${i}`),
        }),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balanceOf(runtime.db, e1 ?? '')).toBe(20n);
    expect(await balanceOf(runtime.db, e2 ?? '')).toBe(20n);
  });
});
