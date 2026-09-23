import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDetailResource, AccountEntryResource, AccountResource, EntryDetailResource, EntrySummaryResource, PageResource, ReconcileResource } from '@purse/types';
import { newId, type Id } from '@repo/ids';

import { closeContest, previewSettlement } from '../../src/contests';
import { issuePromoPoints, reverseEntry } from '../../src/ledger';
import { buildArena, inProgress, OPERATOR, score } from '../contests/fixtures';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { consoleClient } from './client';

/**
 * The ledger explorer and the invariant panel (spec 4.10): the account tree with derived
 * balances and owners, one account with its balance now and as of an instant, the entries
 * that touched it with a running balance, one entry with every line balanced per asset and
 * its reversal links, the journal with keyset pages, and `reconcile()` reporting every
 * invariant, red when one fails.
 */
describe('console ledger explorer and invariants', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;

  beforeAll(() => {
    owner = connectMigrator();
    h = harness();
  });
  beforeEach(async () => {
    await wipeLedger(owner);
  });
  afterAll(async () => {
    await wipeLedger(owner);
    await h.close();
    await owner.close();
  });

  async function settledWorld() {
    const arena = await buildArena(h.database.db, { users: 3, funding: 1000n });
    const contest = await inProgress(h.database.db, arena, { entryAmount: 100n, prizeStructure: { type: 'winner_take_all' } });
    await score(h.database.db, arena, contest.id, [9, 5, 1]);
    const preview = await previewSettlement(h.database.db, { tenantId: arena.tenantId, contestId: contest.id });
    const closed = await closeContest(h.database.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key('close') });
    return { arena, contest, closed };
  }

  it('shows the account tree with balances and owners, and refuses without a session', async () => {
    const { arena, contest } = await settledWorld();
    const { api } = await consoleClient(h, owner.db, 'operator');
    const tree = await api.get<{ accounts: AccountResource[] }>(`/console/tenants/${arena.tenantId}/accounts`);
    expect(tree.status).toBe(200);
    const kinds = tree.data?.accounts.map((each) => each.kind);
    // Kind order follows the spec 4.2.1 table: wallets, escrows, then the platform accounts.
    expect(kinds).toEqual(['user_wallet', 'user_wallet', 'user_wallet', 'contest_escrow', 'promo_liability']);
    const escrow = tree.data?.accounts.find((each) => each.kind === 'contest_escrow');
    expect(escrow).toMatchObject({ id: contest.escrowAccountId, balance: '0', asset: 'POINTS', normalSide: 'credit', owner: { kind: 'contest', id: contest.id, state: 'settled' } });
    const winner = tree.data?.accounts.find((each) => each.kind === 'user_wallet' && each.balance === '1200');
    expect(winner?.owner).toMatchObject({ kind: 'user', id: arena.users[0] });
    // The promo liability was debited by every issue, so relative to its credit normal side it reads negative.
    const promo = tree.data?.accounts.find((each) => each.kind === 'promo_liability');
    expect(promo).toMatchObject({ balance: '-3000', owner: null, lineCount: 3 });
    // Every balance nets to zero across the tenant, the way a closed-loop ledger must.
    const net = tree.data?.accounts.reduce((sum, each) => sum + (each.normalSide === 'credit' ? BigInt(each.balance) : -BigInt(each.balance)), 0n);
    expect(net).toBe(0n);
    expect((await h.app.request(`/console/tenants/${arena.tenantId}/accounts`)).status).toBe(401);
  });

  it('answers a point-in-time balance from balanceOf(asOf) and pages an account’s entries newest first with a running balance', async () => {
    const { arena, closed } = await settledWorld();
    const { api } = await consoleClient(h, owner.db, 'operator');
    const winnerWallet = (await api.get<{ accounts: AccountResource[] }>(`/console/tenants/${arena.tenantId}/accounts`)).data?.accounts.find((each) => each.kind === 'user_wallet' && each.balance === '1200');
    const accountId = winnerWallet?.id ?? '';

    const now = await api.get<AccountDetailResource>(`/console/accounts/${accountId}`);
    expect(now.status).toBe(200);
    expect(now.data).toMatchObject({ balance: '1200', asOf: null, lineCount: 3 });
    expect(now.data?.firstPostedAt).not.toBeNull();

    const entries = await api.get<PageResource<AccountEntryResource>>(`/console/accounts/${accountId}/entries?limit=2`);
    expect(entries.data?.items.map((each) => [each.entry.kind, each.delta, each.balanceAfter])).toEqual([
      ['settle', '300', '1200'],
      ['escrow', '-100', '900'],
    ]);
    expect(entries.data?.nextCursor).toMatch(/^\d+:je_/);
    const rest = await api.get<PageResource<AccountEntryResource>>(`/console/accounts/${accountId}/entries?limit=2&cursor=${entries.data?.nextCursor}`);
    expect(rest.data?.items.map((each) => [each.entry.kind, each.delta, each.balanceAfter])).toEqual([['issue', '1000', '1000']]);
    expect(rest.data?.nextCursor).toBeNull();

    // As of the instant the escrow entry posted, the settlement had not happened: 900.
    const escrowPostedAt = entries.data?.items[1]?.entry.postedAt ?? '';
    const asOf = await api.get<AccountDetailResource>(`/console/accounts/${accountId}?asOf=${encodeURIComponent(escrowPostedAt)}`);
    expect(asOf.data?.asOf).toEqual({ at: escrowPostedAt, balance: '900' });
    const before = await api.get<AccountDetailResource>(`/console/accounts/${accountId}?asOf=2000-01-01T00:00:00.000Z`);
    expect(before.data?.asOf?.balance).toBe('0');
    expect((await api.get(`/console/accounts/${accountId}?asOf=yesterday`)).status).toBe(400);
    expect((await api.get(`/console/accounts/${accountId}/entries?cursor=junk`)).status).toBe(400);
    expect((await api.get('/console/accounts/acct_00000000-0000-7000-8000-000000000000')).status).toBe(400);
    expect(closed.entry?.entry.id).toBe(entries.data?.items[0]?.entry.id);
  });

  it('drills into an entry: every line with its account, per-asset totals that balance, the contest, and reversal links both ways', async () => {
    const { arena, closed } = await settledWorld();
    const { api } = await consoleClient(h, owner.db, 'operator');
    const settleId = closed.entry?.entry.id ?? '';
    const detail = await api.get<EntryDetailResource>(`/console/entries/${settleId}`);
    expect(detail.status).toBe(200);
    expect(detail.data?.entry).toMatchObject({ id: settleId, kind: 'settle', contestId: closed.contest.id });
    expect(detail.data?.balanced).toBe(true);
    expect(detail.data?.totals).toEqual([{ asset: 'POINTS', debits: '300', credits: '300', balanced: true }]);
    expect(detail.data?.lines.map((each) => [each.account.kind, each.line.direction, each.line.amount, each.delta])).toEqual([
      ['contest_escrow', 'debit', '300', '-300'],
      ['user_wallet', 'credit', '300', '300'],
    ]);
    expect(detail.data?.contest).toEqual({ id: closed.contest.id, title: closed.contest.title, state: 'settled' });
    expect(detail.data?.reverses).toBeNull();
    expect(detail.data?.reversedBy).toBeNull();

    // Reverse a promo issue and both entries link to each other.
    const promo = arena.promo;
    const walletId = detail.data?.lines[1]?.account.id ?? '';
    const issued = await issuePromoPoints(h.database.db, { tenantId: arena.tenantId, asset: 'POINTS', promoLiabilityAccountId: promo.id, walletAccountId: walletId, amount: 7n, idempotencyKey: key('issue') });
    const reversal = await reverseEntry(h.database.db, { tenantId: arena.tenantId, entryId: issued.entry.id as Id<'je'>, idempotencyKey: key('reverse') });
    const original = await api.get<EntryDetailResource>(`/console/entries/${issued.entry.id}`);
    expect(original.data?.reversedBy?.id).toBe(reversal.entry.id);
    const corrected = await api.get<EntryDetailResource>(`/console/entries/${reversal.entry.id}`);
    expect(corrected.data?.reverses?.id).toBe(issued.entry.id);
    expect(corrected.data?.entry.kind).toBe('reversal');
    expect((await api.get('/console/entries/je_00000000-0000-7000-8000-000000000000')).status).toBe(400);
  });

  it('lists a tenant’s journal newest first, by kind and by contest, in keyset pages', async () => {
    const { arena, contest } = await settledWorld();
    const { api } = await consoleClient(h, owner.db, 'operator');
    const all = await api.get<PageResource<EntrySummaryResource>>(`/console/tenants/${arena.tenantId}/entries?limit=3`);
    expect(all.data?.items.map((each) => each.entry.kind)).toEqual(['settle', 'escrow', 'escrow']);
    expect(all.data?.items[0]).toMatchObject({ lineCount: 2, asset: 'POINTS', amount: '300' });
    const next = await api.get<PageResource<EntrySummaryResource>>(`/console/tenants/${arena.tenantId}/entries?limit=3&cursor=${all.data?.nextCursor}`);
    expect(next.data?.items.map((each) => each.entry.kind)).toEqual(['escrow', 'issue', 'issue']);
    const last = await api.get<PageResource<EntrySummaryResource>>(`/console/tenants/${arena.tenantId}/entries?limit=3&cursor=${next.data?.nextCursor}`);
    expect(last.data?.items.map((each) => each.entry.kind)).toEqual(['issue']);
    expect(last.data?.nextCursor).toBeNull();
    const byKind = await api.get<PageResource<EntrySummaryResource>>(`/console/tenants/${arena.tenantId}/entries?kind=issue`);
    expect(byKind.data?.items).toHaveLength(3);
    const byContest = await api.get<PageResource<EntrySummaryResource>>(`/console/tenants/${arena.tenantId}/entries?contestId=${contest.id}`);
    expect(byContest.data?.items.map((each) => each.entry.kind)).toEqual(['settle', 'escrow', 'escrow', 'escrow']);
    const other = await buildArena(h.database.db, { users: 0 });
    expect((await api.get<PageResource<EntrySummaryResource>>(`/console/tenants/${other.tenantId}/entries`)).data?.items).toEqual([]);
  });

  it('runs reconcile on demand, reporting every invariant, and reports red without an error envelope when one is broken', async () => {
    await settledWorld();
    const { api } = await consoleClient(h, owner.db, 'operator');
    const clean = await api.get<ReconcileResource>('/console/reconcile');
    expect(clean.status).toBe(200);
    expect(clean.data?.ok).toBe(true);
    expect(clean.data?.invariants.map((each) => each.id)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
    expect(clean.data?.invariants.every((each) => each.status === 'ok')).toBe(true);
    expect(Date.parse(clean.data?.ranAt ?? '')).not.toBeNaN();

    // Break I3 as the owner (only the owner can): a corrupt entry that drives a wallet negative, the
    // commit-time balance trigger switched off for that one transaction, as test/ledger/reconcile.test.ts does.
    const [wallet] = await owner.sql<Array<{ id: string; tenant_id: string }>>`select id, tenant_id from accounts where kind = 'user_wallet' limit 1`;
    const [fee] = await owner.sql<Array<{ id: string }>>`select id from accounts where kind = 'promo_liability' limit 1`;
    await owner.sql.begin(async (tx) => {
      await tx`alter table journal_lines disable trigger journal_lines_entry_balanced`;
      const entryId = newId('je');
      await tx`insert into journal_entries (id, tenant_id, kind, description, idempotency_key, request_hash) values (${entryId}, ${wallet?.tenant_id ?? ''}, 'adjustment', 'corrupt', ${key('corrupt')}, 'x')`;
      await tx`insert into journal_lines (id, entry_id, account_id, direction, amount, asset, sequence) values (${newId('jl')}, ${entryId}, ${wallet?.id ?? ''}, 'debit', 5000, 'POINTS', 1), (${newId('jl')}, ${entryId}, ${fee?.id ?? ''}, 'credit', 5000, 'POINTS', 2)`;
      await tx`alter table journal_lines enable trigger journal_lines_entry_balanced`;
    });
    const broken = await api.get<ReconcileResource>('/console/reconcile');
    expect(broken.status).toBe(200);
    expect(broken.data?.ok).toBe(false);
    const failed = broken.data?.invariants.filter((each) => each.status === 'failed').map((each) => each.id);
    expect(failed).toContain('I3');
    expect(broken.data?.invariants.find((each) => each.id === 'I3')?.detail).toMatch(/negative/);
    // Whereas the internal route, built for a scheduler, answers 500.
    expect((await h.app.request('/internal/reconcile')).status).toBe(500);
  });
});
