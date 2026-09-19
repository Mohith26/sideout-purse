import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LedgerReplayResource } from '@purse/types';
import { newId, type Id } from '@repo/ids';

import { balanceOf, issuePromoPoints, reverseEntry } from '../../src/ledger';
import { buildArena, inProgress } from '../contests/fixtures';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { createTenant, key, openPlatform, openWallet, wipeLedger } from '../ledger/fixtures';
import { consoleClient } from './client';

describe('console ledger replay', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;
  beforeAll(() => { owner = connectMigrator(); h = harness(); });
  beforeEach(async () => { await wipeLedger(owner); });
  afterAll(async () => { await wipeLedger(owner); await h.close(); await owner.close(); });

  it('rebuilds first, middle and last balances, changed sets and contest escrows', async () => {
    const arena = await buildArena(h.database.db, { users: 3 });
    const contest = await inProgress(h.database.db, arena);
    // Fixture timestamps are exact milliseconds, to compare with balanceOf's Date API.
    await owner.sql`with ranked as (select id, row_number() over (order by posted_at, id) n from journal_entries)
      update journal_entries e set posted_at = '2025-01-01'::timestamptz + r.n * interval '1 second' from ranked r where e.id = r.id`;
    const { api } = await consoleClient(h, owner.db, 'operator');
    const path = `/console/tenants/${arena.tenantId}/ledger/replay`;
    const latest = await api.get<LedgerReplayResource>(path);
    expect(latest.status).toBe(200);
    expect(latest.data).toMatchObject({ position: 6, total: 6, accountCount: 5, nextAccountCursor: null });
    for (const position of [1, 3, 6]) {
      const res = await api.get<LedgerReplayResource>(`${path}?position=${position}`);
      expect(res.status).toBe(200);
      const view = res.data;
      if (view?.entry === null || view?.entry === undefined) throw new Error('Missing replay');
      expect(view.position).toBe(position);
      const previous = position === 1 ? null : (await api.get<LedgerReplayResource>(`${path}?position=${position - 1}`)).data;
      const changed: string[] = [];
      for (const account of view.accounts) {
        expect(BigInt(account.balance)).toBe(await balanceOf(h.database.db, account.id, new Date(view.entry.postedAt)));
        const before = previous?.accounts.find((a) => a.id === account.id)?.balance ?? '0';
        expect(BigInt(account.delta)).toBe(BigInt(account.balance) - BigInt(before));
        if (account.balance !== before) changed.push(account.id);
      }
      expect(view.changedAccountIds).toEqual(changed.sort());
      expect(view.totals).toEqual([{ asset: 'POINTS', net: '0' }]);
      expect(view.entryTotals.every((t) => t.debits === t.credits)).toBe(true);
      expect((await api.get<LedgerReplayResource>(`${path}?at=${view.entry.id}`)).data).toEqual(view);
      expect(view.escrows).toHaveLength(position > 3 ? 1 : 0);
    }
    expect(latest.data?.escrows[0]).toMatchObject({ id: contest.escrowAccountId, balance: '300' });
    expect((await h.app.request(path)).status).toBe(401);
  });

  it('handles empty journals, unknown positions, invalid queries and tenant boundaries', async () => {
    const arena = await buildArena(h.database.db, { users: 1 });
    const other = await createTenant(h.database.db);
    const { api } = await consoleClient(h, owner.db);
    const path = `/console/tenants/${other}/ledger/replay`;
    const empty = await api.get<LedgerReplayResource>(path);
    expect(empty.data).toMatchObject({ position: 0, total: 0, entry: null, accounts: [], lines: [], changedAccountIds: [], escrows: [] });
    const foreign = await api.get<LedgerReplayResource>(`/console/tenants/${arena.tenantId}/ledger/replay`);
    for (const query of [`at=${foreign.data?.entry?.id}`, `at=${newId('je')}`, 'position=1']) {
      const res = await api.get(`${path}?${query}`);
      expect(res.status).toBe(400);
      expect(res.error?.code).toBe('entry_not_found');
    }
    for (const query of ['position=0', 'position=1.5', 'position=9007199254740992', 'at=no', 'after=no', `at=${newId('je')}&position=1`]) {
      expect((await api.get(`${path}?${query}`)).error?.code).toBe('validation_failed');
    }
  });

  it('keeps exact amounts above Number precision, orders timestamp ties by ID, and replays reversals', async () => {
    const tenantId = await createTenant(h.database.db);
    const promo = await openPlatform(h.database.db, tenantId, 'promo_liability');
    const wallet = await openWallet(h.database.db, tenantId);
    const amount = 9007199254740993n;
    const issue = await issuePromoPoints(h.database.db, { tenantId, asset: 'POINTS', promoLiabilityAccountId: promo.id, walletAccountId: wallet.id, amount, idempotencyKey: key('large') });
    const reversal = await reverseEntry(h.database.db, { tenantId, entryId: issue.entry.id as Id<'je'>, idempotencyKey: key('reverse') });
    await owner.sql`update journal_entries set posted_at = '2025-01-01T00:00:00.123456Z'::timestamptz where tenant_id = ${tenantId}`;
    const { api } = await consoleClient(h, owner.db);
    const path = `/console/tenants/${tenantId}/ledger/replay`;
    const first = (await api.get<LedgerReplayResource>(`${path}?position=1`)).data;
    const last = (await api.get<LedgerReplayResource>(path)).data;
    expect(first?.entry?.id).toBe([issue.entry.id, reversal.entry.id].sort()[0]);
    expect(first?.accounts.find((a) => a.id === wallet.id)?.balance).toBe(first?.entry?.id === issue.entry.id ? amount.toString() : (-amount).toString());
    expect(last?.accounts.every((a) => a.balance === '0')).toBe(true);
    expect(last?.changedAccountIds.sort()).toEqual([promo.id, wallet.id].sort());
    expect(last?.totals).toEqual([{ asset: 'POINTS', net: '0' }]);
    expect((await api.get<LedgerReplayResource>(`${path}?at=${first?.entry?.id}`)).data).toEqual(first);
  });

  it('pages all wallets without losing whole-tenant conservation or changed accounts', async () => {
    const tenantId = await createTenant(h.database.db);
    const promo = await openPlatform(h.database.db, tenantId, 'promo_liability');
    const wallets = [];
    for (let i = 0; i < 201; i += 1) wallets.push(await openWallet(h.database.db, tenantId));
    const wallet = wallets.at(-1);
    if (wallet === undefined) throw new Error('Missing wallet');
    const issue = await issuePromoPoints(h.database.db, { tenantId, asset: 'POINTS', promoLiabilityAccountId: promo.id, walletAccountId: wallet.id, amount: 17n, idempotencyKey: key('issue') });
    const { api } = await consoleClient(h, owner.db);
    const path = `/console/tenants/${tenantId}/ledger/replay?at=${issue.entry.id}`;
    const first = (await api.get<LedgerReplayResource>(path)).data;
    expect(first?.accounts).toHaveLength(200);
    expect(first?.accountCount).toBe(202);
    expect(first?.nextAccountCursor).not.toBeNull();
    const second = (await api.get<LedgerReplayResource>(`${path}&after=${first?.nextAccountCursor}`)).data;
    expect(second?.accounts).toHaveLength(2);
    expect(second?.nextAccountCursor).toBeNull();
    expect(new Set([...first?.accounts ?? [], ...second?.accounts ?? []].map((a) => a.id)).size).toBe(202);
    expect(first?.totals).toEqual(second?.totals);
    expect(first?.changedAccountIds).toEqual(second?.changedAccountIds);
    expect(first?.changedAccountIds.sort()).toEqual([promo.id, wallet.id].sort());
  });
});
