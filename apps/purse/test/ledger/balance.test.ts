import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Id } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { balanceOf, balancesOf, escrowEntry, issuePromoPoints, reverseEntry, settleEscrow, signedDelta, type PostedEntry } from '../../src/ledger';
import { connectMigrator, connectRuntime } from '../helpers';
import { buildWorld, key, wipeLedger, type World } from './fixtures';

/**
 * Spec 4.2.3: point-in-time balances fall out of an append-only journal by bounding on
 * `posted_at`. Post a sequence, then ask for the balance as of every entry and check it
 * against a replay of the lines up to that entry.
 */
describe('balanceOf(asOf)', () => {
  let migrator: Database;
  let runtime: Database;
  let world: World;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    world = await buildWorld(runtime.db, { wallets: 3, escrows: 1 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('answers the balance as it stood after each entry, and zero before the first', async () => {
    const w = world.wallets.map((a) => a.id);
    const escrow = world.escrows[0]?.id ?? '';
    const common = { tenantId: world.tenantId, asset: 'POINTS' as const };
    const posted: PostedEntry[] = [];
    posted.push(await issuePromoPoints(runtime.db, { ...common, promoLiabilityAccountId: world.promo.id, walletAccountId: w[0] ?? '', amount: 500n, idempotencyKey: key() }));
    posted.push(await issuePromoPoints(runtime.db, { ...common, promoLiabilityAccountId: world.promo.id, walletAccountId: w[1] ?? '', amount: 300n, idempotencyKey: key() }));
    posted.push(await escrowEntry(runtime.db, { ...common, walletAccountId: w[0] ?? '', escrowAccountId: escrow, amount: 200n, idempotencyKey: key() }));
    posted.push(await escrowEntry(runtime.db, { ...common, walletAccountId: w[1] ?? '', escrowAccountId: escrow, amount: 100n, idempotencyKey: key() }));
    posted.push(await reverseEntry(runtime.db, { entryId: posted[3]?.entry.id as Id<'je'>, idempotencyKey: key() }));
    posted.push(await escrowEntry(runtime.db, { ...common, walletAccountId: w[1] ?? '', escrowAccountId: escrow, amount: 150n, idempotencyKey: key() }));
    posted.push(
      await settleEscrow(runtime.db, {
        ...common,
        escrowAccountId: escrow,
        payouts: [
          { walletAccountId: w[2] ?? '', amount: 200n },
          { walletAccountId: w[0] ?? '', amount: 100n },
          { walletAccountId: w[1] ?? '', amount: 50n },
        ],
        idempotencyKey: key(),
      }),
    );

    // posted_at is set after every lock is taken, so it follows commit order for entries
    // that share an account; here every entry touches the escrow or a wallet another entry
    // touches, so the sequence never goes backwards (ties within one millisecond are fine).
    const times = posted.map((p) => p.entry.postedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const p of posted) expect(p.entry.postedAt.getTime()).toBeGreaterThanOrEqual(p.entry.createdAt.getTime());

    const everyAccount = [world.promo.id, escrow, ...w];
    const normalSide = new Map([...world.wallets, ...world.escrows, world.promo].map((a) => [a.id, a.normalSide]));

    const beforeFirst = new Date(Math.min(...times) - 1);
    for (const id of everyAccount) expect(await balanceOf(runtime.db, id, beforeFirst)).toBe(0n);

    for (const { entry } of posted) {
      const asOf = entry.postedAt;
      for (const id of everyAccount) {
        // Replay every line whose entry was posted at or before asOf.
        const expected = posted
          .filter((p) => p.entry.postedAt.getTime() <= asOf.getTime())
          .flatMap((p) => p.lines)
          .filter((line) => line.accountId === id)
          .reduce((sum, line) => sum + signedDelta(normalSide.get(id) ?? 'credit', line.direction, line.amount), 0n);
        expect(await balanceOf(runtime.db, id, asOf)).toBe(expected);
      }
    }

    // Without asOf, the balance is the whole journal, and the multi-account query agrees.
    expect(await balanceOf(runtime.db, w[0] ?? '')).toBe(400n);
    expect(await balanceOf(runtime.db, w[1] ?? '')).toBe(200n);
    expect(await balanceOf(runtime.db, w[2] ?? '')).toBe(200n);
    expect(await balanceOf(runtime.db, escrow)).toBe(0n);
    expect(await balanceOf(runtime.db, world.promo.id)).toBe(-800n);
    const all = await balancesOf(runtime.db, everyAccount);
    for (const id of everyAccount) expect(all.get(id)).toBe(await balanceOf(runtime.db, id));
    expect((await balancesOf(runtime.db, [])).size).toBe(0);
    expect((await balancesOf(runtime.db, ['acct_01a0b16a-b475-74d4-b1cb-2dbdc08845a9'])).size).toBe(0);
  });
});
