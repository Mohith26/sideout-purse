import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type Id } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { accounts, journalEntries, journalLines } from '../../src/db/schema';
import {
  balanceOf,
  escrowEntry,
  findEntryByKey,
  isLedgerError,
  issuePromoPoints,
  LedgerError,
  postEntry,
  reconcile,
  refundEscrow,
  reverseEntry,
  reversalOf,
  settleEscrow,
  voidEscrow,
  type PostEntryInput,
} from '../../src/ledger';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { buildWorld, createTenant, key, openWallet, wipeLedger, type World } from './fixtures';

/**
 * The seven journal rules (spec 4.2.2) as the runtime role experiences them through
 * `postEntry` and the typed flows, plus the database constraints behind them, exercised
 * directly as the owner to show they hold even for code that bypasses the service.
 */
describe('postEntry', () => {
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

  const wallet = (i: number) => world.wallets[i]?.id ?? '';
  const escrow = () => world.escrows[0]?.id ?? '';

  async function entryCount(): Promise<number> {
    const [row] = await runtime.db.select({ n: count() }).from(journalEntries);
    return row?.n ?? 0;
  }

  async function ledgerError(promise: Promise<unknown>): Promise<LedgerError> {
    const error = await rejection(promise);
    if (!(error instanceof LedgerError)) throw new Error(`expected a LedgerError, got ${String(error)}`);
    return error;
  }

  describe('the standard flows (spec 4.2.5)', () => {
    it('issue, escrow, refund, settle and void move value exactly as the spec lists them', async () => {
      const issued = await issuePromoPoints(runtime.db, {
        tenantId: world.tenantId,
        asset: 'POINTS',
        promoLiabilityAccountId: world.promo.id,
        walletAccountId: wallet(0),
        amount: 1000n,
        idempotencyKey: key('issue'),
      });
      expect(issued.replayed).toBe(false);
      expect(issued.entry.kind).toBe('issue');
      expect(issued.lines.map((l) => [l.sequence, l.direction, l.amount, l.asset])).toEqual([
        [1, 'debit', 1000n, 'POINTS'],
        [2, 'credit', 1000n, 'POINTS'],
      ]);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(1000n);
      expect(await balanceOf(runtime.db, world.promo.id)).toBe(-1000n);

      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(1), amount: 500n, idempotencyKey: key() });
      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(2), amount: 500n, idempotencyKey: key() });

      const contestId = newId('cnt');
      const enter = (i: number) =>
        escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(i), escrowAccountId: escrow(), amount: 100n, contestId, idempotencyKey: key('enter') });
      const e0 = await enter(0);
      const e1 = await enter(1);
      const e2 = await enter(2);
      expect(e0.entry.contestId).toBe(contestId);
      expect(await balanceOf(runtime.db, escrow())).toBe(300n);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(900n);

      // Withdraw before lock: a refund entry, not a reversal.
      const refund = await refundEscrow(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', escrowAccountId: escrow(), walletAccountId: wallet(2), amount: 100n, contestId, idempotencyKey: key('refund') });
      expect(refund.entry.kind).toBe('refund');
      expect(refund.entry.reversesEntryId).toBeNull();
      expect(await balanceOf(runtime.db, escrow())).toBe(200n);
      expect(await balanceOf(runtime.db, wallet(2))).toBe(500n);

      // Void one entrant: the reversing entry of their escrow entry.
      const voided = await voidEscrow(runtime.db, { tenantId: world.tenantId, entryId: e1.entry.id as Id<'je'>, idempotencyKey: key('void') });
      expect(voided.entry.kind).toBe('void');
      expect(voided.entry.reversesEntryId).toBe(e1.entry.id);
      expect(voided.entry.contestId).toBe(contestId);
      expect(voided.lines.map((l) => [l.accountId, l.direction, l.amount])).toEqual([
        [wallet(1), 'credit', 100n],
        [escrow(), 'debit', 100n],
      ]);
      expect(await balanceOf(runtime.db, escrow())).toBe(100n);
      expect(await balanceOf(runtime.db, wallet(1))).toBe(500n);

      // Settle: one entry, many lines, must balance.
      const settled = await settleEscrow(runtime.db, {
        tenantId: world.tenantId,
        asset: 'POINTS',
        escrowAccountId: escrow(),
        payouts: [
          { walletAccountId: wallet(0), amount: 60n },
          { walletAccountId: wallet(1), amount: 30n },
          { walletAccountId: wallet(2), amount: 10n },
        ],
        contestId,
        idempotencyKey: key('settle'),
      });
      expect(settled.lines).toHaveLength(4);
      expect(settled.lines[0]).toMatchObject({ accountId: escrow(), direction: 'debit', amount: 100n, sequence: 1 });
      expect(await balanceOf(runtime.db, escrow())).toBe(0n);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(960n);
      expect(await balanceOf(runtime.db, wallet(1))).toBe(530n);
      expect(await balanceOf(runtime.db, wallet(2))).toBe(510n);

      expect(e2.replayed).toBe(false);
      expect(await entryCount()).toBe(9);
    });

    it('the typed flows refuse the wrong kind of account on either side', async () => {
      const wrong = await ledgerError(
        issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: escrow(), amount: 10n, idempotencyKey: key() }),
      );
      expect(wrong.code).toBe('account_kind_mismatch');
      expect(wrong.detail).toMatchObject({ expected: 'user_wallet', actual: 'contest_escrow' });

      const fromWallet = await ledgerError(
        settleEscrow(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', escrowAccountId: wallet(0), payouts: [{ walletAccountId: wallet(1), amount: 1n }], idempotencyKey: key() }),
      );
      expect(fromWallet.code).toBe('account_kind_mismatch');

      const empty = await ledgerError(settleEscrow(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', escrowAccountId: escrow(), payouts: [], idempotencyKey: key() }));
      expect(empty.code).toBe('too_few_lines');
      expect(await entryCount()).toBe(0);
    });
  });

  describe('rules 1 to 4 through the service', () => {
    const base = (): Omit<PostEntryInput, 'lines'> => ({ tenantId: world.tenantId, kind: 'adjustment', description: 'test', idempotencyKey: key() });

    it('refuses one line, an unbalanced pair, mixed assets and a non-positive amount, writing nothing', async () => {
      expect((await ledgerError(postEntry(runtime.db, { ...base(), lines: [{ accountId: wallet(0), direction: 'credit', amount: 1n, asset: 'POINTS' }] }))).code).toBe('too_few_lines');
      expect(
        (
          await ledgerError(
            postEntry(runtime.db, {
              ...base(),
              lines: [
                { accountId: world.promo.id, direction: 'debit', amount: 10n, asset: 'POINTS' },
                { accountId: wallet(0), direction: 'credit', amount: 9n, asset: 'POINTS' },
              ],
            }),
          )
        ).code,
      ).toBe('unbalanced');
      expect(
        (
          await ledgerError(
            postEntry(runtime.db, {
              ...base(),
              lines: [
                { accountId: world.promo.id, direction: 'debit', amount: 10n, asset: 'POINTS' },
                { accountId: wallet(0), direction: 'credit', amount: 10n, asset: 'CREDIT' },
              ],
            }),
          )
        ).code,
      ).toBe('mixed_assets');
      expect(
        (
          await ledgerError(
            postEntry(runtime.db, {
              ...base(),
              lines: [
                { accountId: world.promo.id, direction: 'debit', amount: 0n, asset: 'POINTS' },
                { accountId: wallet(0), direction: 'credit', amount: 0n, asset: 'POINTS' },
              ],
            }),
          )
        ).code,
      ).toBe('non_positive_amount');
      expect(await entryCount()).toBe(0);
    });

    it('refuses a line whose asset is not its account’s, an unknown, closed or foreign account', async () => {
      const creditWallet = await openWallet(runtime.db, world.tenantId, 'CREDIT');
      const mismatch = await ledgerError(
        postEntry(runtime.db, {
          ...base(),
          lines: [
            { accountId: world.promo.id, direction: 'debit', amount: 10n, asset: 'POINTS' },
            { accountId: creditWallet.id, direction: 'credit', amount: 10n, asset: 'POINTS' },
          ],
        }),
      );
      expect(mismatch.code).toBe('account_asset_mismatch');

      const missing = await ledgerError(
        postEntry(runtime.db, {
          ...base(),
          lines: [
            { accountId: world.promo.id, direction: 'debit', amount: 10n, asset: 'POINTS' },
            { accountId: newId('acct'), direction: 'credit', amount: 10n, asset: 'POINTS' },
          ],
        }),
      );
      expect(missing.code).toBe('account_not_found');

      const otherTenant = await createTenant(runtime.db);
      const foreign = await openWallet(runtime.db, otherTenant);
      const crossTenant = await ledgerError(
        postEntry(runtime.db, {
          ...base(),
          lines: [
            { accountId: world.promo.id, direction: 'debit', amount: 10n, asset: 'POINTS' },
            { accountId: foreign.id, direction: 'credit', amount: 10n, asset: 'POINTS' },
          ],
        }),
      );
      expect(crossTenant.code).toBe('account_wrong_tenant');
      expect(crossTenant.apiType).toBe('permission_error');

      await runtime.db.update(accounts).set({ status: 'frozen' }).where(eq(accounts.id, wallet(1)));
      const frozen = await ledgerError(
        postEntry(runtime.db, {
          ...base(),
          lines: [
            { accountId: world.promo.id, direction: 'debit', amount: 10n, asset: 'POINTS' },
            { accountId: wallet(1), direction: 'credit', amount: 10n, asset: 'POINTS' },
          ],
        }),
      );
      expect(frozen.code).toBe('account_not_open');
      expect(await entryCount()).toBe(0);
    });

    it('refuses a bad key or description before touching the database', async () => {
      const lines: PostEntryInput['lines'] = [
        { accountId: world.promo.id, direction: 'debit', amount: 1n, asset: 'POINTS' },
        { accountId: wallet(0), direction: 'credit', amount: 1n, asset: 'POINTS' },
      ];
      expect((await ledgerError(postEntry(runtime.db, { ...base(), idempotencyKey: '', lines }))).code).toBe('invalid_idempotency_key');
      expect((await ledgerError(postEntry(runtime.db, { ...base(), idempotencyKey: 'has space', lines }))).code).toBe('invalid_idempotency_key');
      expect((await ledgerError(postEntry(runtime.db, { ...base(), idempotencyKey: 'x'.repeat(256), lines }))).code).toBe('invalid_idempotency_key');
      expect((await ledgerError(postEntry(runtime.db, { ...base(), description: '   ', lines }))).code).toBe('invalid_description');
    });
  });

  describe('rule 7: idempotency', () => {
    it('replaying a key returns the identical entry and lines and creates nothing new', async () => {
      const input = {
        tenantId: world.tenantId,
        asset: 'POINTS' as const,
        promoLiabilityAccountId: world.promo.id,
        walletAccountId: wallet(0),
        amount: 250n,
        idempotencyKey: key('replay'),
      };
      const first = await issuePromoPoints(runtime.db, input);
      const second = await issuePromoPoints(runtime.db, input);
      expect(second.replayed).toBe(true);
      expect(second.entry).toEqual(first.entry);
      expect(second.lines).toEqual(first.lines);
      expect(second.lines.map((l) => l.id)).toEqual(first.lines.map((l) => l.id));
      expect(await entryCount()).toBe(1);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(250n);
    });

    it('the same key with a different payload is a conflict, not a silent replay', async () => {
      const k = key('conflict');
      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 250n, idempotencyKey: k });
      const conflict = await ledgerError(
        issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 251n, idempotencyKey: k }),
      );
      expect(conflict.code).toBe('idempotency_conflict');
      expect(conflict.apiType).toBe('conflict');
      // Same lines, different description: still a different request.
      const described = await ledgerError(
        issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 250n, idempotencyKey: k, description: 'other' }),
      );
      expect(described.code).toBe('idempotency_conflict');
      expect(await entryCount()).toBe(1);
    });

    it('keys are scoped to the tenant: another tenant using the same key posts its own entry and learns nothing', async () => {
      const k = key('shared');
      const mine = { tenantId: world.tenantId, asset: 'POINTS' as const, promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 5n, idempotencyKey: k };
      const first = await issuePromoPoints(runtime.db, mine);

      const other = await buildWorld(runtime.db, { wallets: 1, escrows: 0 });
      const theirs = await issuePromoPoints(runtime.db, { tenantId: other.tenantId, asset: 'POINTS', promoLiabilityAccountId: other.promo.id, walletAccountId: other.wallets[0]?.id ?? '', amount: 9n, idempotencyKey: k });
      expect(theirs.replayed).toBe(false);
      expect(theirs.entry.id).not.toBe(first.entry.id);
      expect(theirs.entry.idempotencyKey).toBe(k);
      expect(await entryCount()).toBe(2);

      // Each tenant's replay is its own entry, and neither can see the other's under the key.
      const again = await issuePromoPoints(runtime.db, mine);
      expect(again).toEqual({ ...first, replayed: true });
      expect((await findEntryByKey(runtime.db, other.tenantId, k))?.id).toBe(theirs.entry.id);
      expect((await findEntryByKey(runtime.db, world.tenantId, k))?.id).toBe(first.entry.id);
      expect(await findEntryByKey(runtime.db, await createTenant(runtime.db), k)).toBeUndefined();
    });

    it('a replay of a refused request is refused again, not turned into a post', async () => {
      const k = key('refused');
      const attempt = () => escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 5n, idempotencyKey: k });
      expect((await ledgerError(attempt())).code).toBe('insufficient_funds');
      expect((await ledgerError(attempt())).code).toBe('insufficient_funds');
      expect(await entryCount()).toBe(0);
    });
  });

  describe('I3 at write time', () => {
    it('refuses a debit that would take a wallet below zero, with the shortfall, and leaves the wallet untouched', async () => {
      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      const refused = await ledgerError(
        escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 101n, idempotencyKey: key() }),
      );
      expect(refused.code).toBe('insufficient_funds');
      expect(refused.apiType).toBe('insufficient_funds');
      expect(refused.detail).toEqual({ accountId: wallet(0), balance: '100', requested: '101', shortfall: '1' });
      expect(await balanceOf(runtime.db, wallet(0))).toBe(100n);

      // Exactly the balance is fine; the wallet lands on zero.
      await escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 100n, idempotencyKey: key() });
      expect(await balanceOf(runtime.db, wallet(0))).toBe(0n);
      // An empty wallet cannot pay anything.
      expect((await ledgerError(escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 1n, idempotencyKey: key() }))).code).toBe('insufficient_funds');
    });

    it('nets several lines on one account before deciding', async () => {
      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 10n, idempotencyKey: key() });
      // Debits 50 and credits 45 on the same wallet holding 10: net -5, covered.
      await postEntry(runtime.db, {
        tenantId: world.tenantId,
        kind: 'adjustment',
        description: 'net',
        idempotencyKey: key(),
        lines: [
          { accountId: wallet(0), direction: 'debit', amount: 50n, asset: 'POINTS' },
          { accountId: wallet(0), direction: 'credit', amount: 45n, asset: 'POINTS' },
          { accountId: world.fee.id, direction: 'credit', amount: 5n, asset: 'POINTS' },
        ],
      });
      expect(await balanceOf(runtime.db, wallet(0))).toBe(5n);
      expect(await balanceOf(runtime.db, world.fee.id)).toBe(5n);
    });

    it('an escrow cannot pay out more than it holds either', async () => {
      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      await escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 40n, idempotencyKey: key() });
      const over = await ledgerError(
        settleEscrow(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', escrowAccountId: escrow(), payouts: [{ walletAccountId: wallet(1), amount: 41n }], idempotencyKey: key() }),
      );
      expect(over.code).toBe('insufficient_funds');
      expect(over.detail).toMatchObject({ accountId: escrow(), balance: '40', requested: '41' });
      // The source accounts are allowed to run negative: issuing is exactly that.
      expect(await balanceOf(runtime.db, world.promo.id)).toBe(-100n);
    });
  });

  describe('rule 6: reversals', () => {
    it('reverseEntry posts the mirror image with reverses_entry_id set, once', async () => {
      const issued = await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      const reversed = await reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key('rev') });
      expect(reversed.entry.kind).toBe('reversal');
      expect(reversed.entry.reversesEntryId).toBe(issued.entry.id);
      expect(reversed.lines.map((l) => [l.accountId, l.direction, l.amount, l.asset, l.sequence])).toEqual([
        [world.promo.id, 'credit', 100n, 'POINTS', 1],
        [wallet(0), 'debit', 100n, 'POINTS', 2],
      ]);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(0n);
      expect(await balanceOf(runtime.db, world.promo.id)).toBe(0n);
      expect((await reversalOf(runtime.db, issued.entry.id))?.id).toBe(reversed.entry.id);

      // Same key: the same reversal comes back. A new key: refused, history is corrected once.
      const again = await reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: reversed.entry.idempotencyKey });
      expect(again.replayed).toBe(true);
      expect(again.entry.id).toBe(reversed.entry.id);
      const twice = await ledgerError(reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key('rev2') }));
      expect(twice.code).toBe('already_reversed');
      expect(twice.detail).toMatchObject({ entryId: issued.entry.id, reversedBy: reversed.entry.id });
      expect(await entryCount()).toBe(2);

      // Reversing the reversal is a new correction and is allowed.
      const unreversed = await reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: reversed.entry.id as Id<'je'>, idempotencyKey: key('rev3') });
      expect(unreversed.entry.reversesEntryId).toBe(reversed.entry.id);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(100n);
    });

    it('a reversal that would overdraw the wallet is refused like any other debit', async () => {
      const issued = await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      await escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 60n, idempotencyKey: key() });
      const refused = await ledgerError(reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key() }));
      expect(refused.code).toBe('insufficient_funds');
      expect(await reversalOf(runtime.db, issued.entry.id)).toBeUndefined();
    });

    it('postEntry with reverses_entry_id set demands the exact mirror, same tenant and same contest', async () => {
      const contestId = newId('cnt');
      await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      const entered = await escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 30n, contestId, idempotencyKey: key() });
      const reversal = (lines: PostEntryInput['lines'], overrides: Partial<PostEntryInput> = {}) =>
        postEntry(runtime.db, {
          tenantId: world.tenantId,
          kind: 'reversal',
          description: 'manual reversal',
          idempotencyKey: key(),
          contestId,
          reversesEntryId: entered.entry.id as Id<'je'>,
          lines,
          ...overrides,
        });
      const mirror: PostEntryInput['lines'] = [
        { accountId: escrow(), direction: 'debit', amount: 30n, asset: 'POINTS' },
        { accountId: wallet(0), direction: 'credit', amount: 30n, asset: 'POINTS' },
      ];

      const wrongAmount = await ledgerError(reversal(mirror.map((l) => ({ ...l, amount: 29n }))));
      expect(wrongAmount.code).toBe('reversal_mismatch');
      const notMirrored = await ledgerError(reversal(mirror.map((l) => ({ ...l, direction: l.direction === 'debit' ? 'credit' : 'debit' }))));
      expect(notMirrored.code).toBe('reversal_mismatch');
      const wrongContest = await ledgerError(reversal(mirror, { contestId: null }));
      expect(wrongContest.code).toBe('reversal_mismatch');
      const unknown = await ledgerError(reversal(mirror, { reversesEntryId: newId('je') }));
      expect(unknown.code).toBe('entry_not_found');

      const otherTenant = await createTenant(runtime.db);
      const otherWallet = await openWallet(runtime.db, otherTenant);
      const foreign = await ledgerError(
        reversal([{ accountId: otherWallet.id, direction: 'debit', amount: 30n, asset: 'POINTS' }, { accountId: otherWallet.id, direction: 'credit', amount: 30n, asset: 'POINTS' }], { tenantId: otherTenant, contestId }),
      );
      expect(foreign.code).toBe('entry_wrong_tenant');

      // Order of lines does not matter; the multiset does.
      const ok = await reversal([...mirror].reverse());
      expect(ok.entry.reversesEntryId).toBe(entered.entry.id);
      expect(await balanceOf(runtime.db, wallet(0))).toBe(100n);
    });

    it('reverseEntry and voidEscrow refuse another tenant’s entry at the ledger boundary', async () => {
      const issued = await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      const entered = await escrowEntry(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 30n, idempotencyKey: key() });
      const intruder = await createTenant(runtime.db);

      const reversal = await ledgerError(reverseEntry(runtime.db, { tenantId: intruder, entryId: entered.entry.id as Id<'je'>, idempotencyKey: key() }));
      expect(reversal.code).toBe('entry_wrong_tenant');
      expect(reversal.apiType).toBe('permission_error');
      const voided = await ledgerError(voidEscrow(runtime.db, { tenantId: intruder, entryId: entered.entry.id as Id<'je'>, idempotencyKey: key() }));
      expect(voided.code).toBe('entry_wrong_tenant');
      // The tenant check comes first, so an intruder does not even learn the entry's kind.
      const notEscrow = await ledgerError(voidEscrow(runtime.db, { tenantId: intruder, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key() }));
      expect(notEscrow.code).toBe('entry_wrong_tenant');
      const unknown = await ledgerError(reverseEntry(runtime.db, { tenantId: intruder, entryId: newId('je'), idempotencyKey: key() }));
      expect(unknown.code).toBe('entry_not_found');

      expect(await reversalOf(runtime.db, entered.entry.id)).toBeUndefined();
      expect(await entryCount()).toBe(2);
      expect(await balanceOf(runtime.db, escrow())).toBe(30n);

      // The owning tenant still can.
      const ok = await voidEscrow(runtime.db, { tenantId: world.tenantId, entryId: entered.entry.id as Id<'je'>, idempotencyKey: key() });
      expect(ok.entry.reversesEntryId).toBe(entered.entry.id);
      expect(ok.entry.tenantId).toBe(world.tenantId);
      expect(await balanceOf(runtime.db, escrow())).toBe(0n);
    });

    it('voidEscrow only voids escrow entries', async () => {
      const issued = await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
      const notEscrow = await ledgerError(voidEscrow(runtime.db, { tenantId: world.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key() }));
      expect(notEscrow.code).toBe('not_reversible');
      expect(isLedgerError(notEscrow, 'not_reversible')).toBe(true);
    });
  });

  describe('the database holds the rules for code that bypasses the service', () => {
    it('CHECKs positive amounts and sequences and the composite (account, asset) foreign key', async () => {
      // As the owner, insert an entry header directly, then try bad lines. Each attempt is
      // a balanced pair with one line altered, so only the altered line can be what fails.
      const entryId = newId('je');
      await migrator.db.insert(journalEntries).values({
        id: entryId,
        tenantId: world.tenantId,
        kind: 'adjustment',
        description: 'raw',
        idempotencyKey: key('raw'),
        requestHash: 'x',
      });
      const line = (overrides: Partial<typeof journalLines.$inferInsert>) =>
        migrator.db
          .insert(journalLines)
          .values([
            { id: newId('jl'), entryId, accountId: wallet(0), direction: 'credit', amount: 1n, asset: 'POINTS', sequence: 1, ...overrides },
            { id: newId('jl'), entryId, accountId: world.promo.id, direction: 'debit', amount: 1n, asset: 'POINTS', sequence: 2 },
          ])
          .then(() => undefined, (error: unknown) => String((error as Error).cause));

      expect(await line({ amount: 0n })).toMatch(/journal_lines_amount_positive/);
      expect(await line({ amount: -5n })).toMatch(/journal_lines_amount_positive/);
      expect(await line({ sequence: 0 })).toMatch(/journal_lines_sequence_positive/);
      expect(await line({ asset: 'CREDIT' })).toMatch(/journal_lines_account_id_asset_fk/);
      expect(await line({ id: 'jl_not-an-id' })).toMatch(/journal_lines_id_prefix/);
      expect(await line({})).toBeUndefined();
      expect(await line({ id: newId('jl') })).toMatch(/journal_lines_entry_id_sequence_key/);
    });

    it('checks rules 1 to 3 at commit for any writer: the owner cannot commit a single-line, mixed-asset or unbalanced entry', async () => {
      const creditWallet = await openWallet(runtime.db, world.tenantId, 'CREDIT');
      type RawLine = { accountId: string; direction: 'debit' | 'credit'; amount: bigint; asset: 'POINTS' | 'CREDIT' };
      const attempt = (lines: RawLine[]) =>
        migrator.db
          .transaction(async (tx) => {
            const entryId = newId('je');
            await tx.insert(journalEntries).values({ id: entryId, tenantId: world.tenantId, kind: 'adjustment', description: 'raw', idempotencyKey: key('raw'), requestHash: 'x' });
            await tx.insert(journalLines).values(lines.map((line, i) => ({ id: newId('jl'), entryId, sequence: i + 1, ...line })));
            // Nothing has objected yet: inside the transaction the entry is visible as written.
            const [row] = await tx.select({ n: count() }).from(journalLines).where(eq(journalLines.entryId, entryId));
            expect(row?.n).toBe(lines.length);
            return entryId;
          })
          .then(
            (entryId) => ({ entryId, failure: undefined }),
            (error: unknown) => ({ entryId: undefined, failure: String((error as Error).cause ?? error) }),
          );
      const promo = world.promo.id;

      const single = await attempt([{ accountId: wallet(0), direction: 'credit', amount: 10n, asset: 'POINTS' }]);
      expect(single.failure).toMatch(/has 1 line\(s\); an entry needs at least two/);
      const mixed = await attempt([
        { accountId: promo, direction: 'debit', amount: 10n, asset: 'POINTS' },
        { accountId: creditWallet.id, direction: 'credit', amount: 10n, asset: 'CREDIT' },
      ]);
      expect(mixed.failure).toMatch(/carries 2 assets; all lines must share one/);
      const unbalanced = await attempt([
        { accountId: promo, direction: 'debit', amount: 10n, asset: 'POINTS' },
        { accountId: wallet(0), direction: 'credit', amount: 7n, asset: 'POINTS' },
      ]);
      expect(unbalanced.failure).toMatch(/does not balance; debits minus credits is 3/);
      // Rolled back at commit: none of the three left a header or a line behind.
      expect(await entryCount()).toBe(0);
      expect((await reconcile(runtime.db)).ok).toBe(true);

      // The same shape, balanced, commits; and the trigger cannot be removed by the runtime.
      const balanced = await attempt([
        { accountId: promo, direction: 'debit', amount: 10n, asset: 'POINTS' },
        { accountId: wallet(0), direction: 'credit', amount: 4n, asset: 'POINTS' },
        { accountId: wallet(1), direction: 'credit', amount: 6n, asset: 'POINTS' },
      ]);
      expect(balanced.failure).toBeUndefined();
      expect(await balanceOf(runtime.db, wallet(1))).toBe(6n);
      const disable = await rejection(runtime.sql`alter table journal_lines disable trigger journal_lines_entry_balanced`);
      expect(String(disable)).toMatch(/must be owner of table journal_lines/);
    });

    it('refuses a second reversal of one entry and a self-reversal even from the owner', async () => {
      const issued = await issuePromoPoints(runtime.db, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 1n, idempotencyKey: key() });
      await reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key() });
      const header = (overrides: Partial<typeof journalEntries.$inferInsert>) =>
        migrator.db
          .insert(journalEntries)
          .values({ id: newId('je'), tenantId: world.tenantId, kind: 'reversal', description: 'raw', idempotencyKey: key('raw'), requestHash: 'x', ...overrides })
          .then(() => undefined, (error: unknown) => String((error as Error).cause));
      expect(await header({ reversesEntryId: issued.entry.id })).toMatch(/journal_entries_reverses_entry_id_key/);
      const selfId = newId('je');
      expect(await header({ id: selfId, reversesEntryId: selfId })).toMatch(/journal_entries_reversal_not_self|journal_entries_reverses_entry_id_fk/);
      expect(await header({ idempotencyKey: issued.entry.idempotencyKey })).toMatch(/journal_entries_tenant_id_idempotency_key_key/);
      expect(await header({ contestId: 'usr_01a0b16a-b475-74d4-b1cb-2dbdc08845a9' })).toMatch(/journal_entries_contest_id_prefix/);
    });
  });

  it('posts inside a caller’s transaction and rolls back with it', async () => {
    const before = await entryCount();
    const failure = await rejection(
      runtime.db.transaction(async (tx) => {
        await issuePromoPoints(tx, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 10n, idempotencyKey: key() });
        expect(await balanceOf(tx, wallet(0))).toBe(10n);
        throw new Error('caller aborts');
      }),
    );
    expect(String(failure)).toMatch(/caller aborts/);
    expect(await entryCount()).toBe(before);
    expect(await balanceOf(runtime.db, wallet(0))).toBe(0n);

    // And a refused post inside a caller's transaction does not poison the transaction.
    await runtime.db.transaction(async (tx) => {
      await issuePromoPoints(tx, { tenantId: world.tenantId, asset: 'POINTS', promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 10n, idempotencyKey: key() });
      const refused = await rejection(escrowEntry(tx, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 11n, idempotencyKey: key() }));
      expect(isLedgerError(refused, 'insufficient_funds')).toBe(true);
      await escrowEntry(tx, { tenantId: world.tenantId, asset: 'POINTS', walletAccountId: wallet(0), escrowAccountId: escrow(), amount: 10n, idempotencyKey: key() });
    });
    expect(await balanceOf(runtime.db, wallet(0))).toBe(0n);
    expect(await balanceOf(runtime.db, escrow())).toBe(10n);
    expect(await entryCount()).toBe(before + 2);
  });
});
