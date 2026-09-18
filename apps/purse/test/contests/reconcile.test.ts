import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { closeContest, previewSettlement, voidContest } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { journalEntries, journalLines, type Contest } from '../../src/db/schema';
import { issuePromoPoints, reconcile } from '../../src/ledger';
import { connectMigrator, connectRuntime } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { buildArena, inProgress, OPERATOR, openWithEntrants, score, type Arena } from './fixtures';

/**
 * Spec 4.2.4 I4, I5 and I7: each catches corruption injected as the owner that the runtime
 * role, the services and the triggers make impossible, which is the reason `reconcile()`
 * exists anyway.
 */
describe('reconcile(): the contest invariants', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 3 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  async function settledContest(): Promise<Contest> {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [3, 2, 1]);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    return (await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() })).contest;
  }

  /** A balanced entry written raw as the owner, so I1 and I2 stay clean and the contest invariant is on its own. */
  async function inject(
    lines: Array<{ accountId: string; direction: 'debit' | 'credit'; amount: bigint }>,
    contestId: string | null = null,
    kind: 'adjustment' | 'settle' | 'escrow' = 'adjustment',
  ): Promise<string> {
    const entryId = newId('je');
    await migrator.db.transaction(async (tx) => {
      await tx.insert(journalEntries).values({ id: entryId, tenantId: arena.tenantId, kind, description: 'injected', idempotencyKey: key('inject'), requestHash: 'x', contestId });
      await tx.insert(journalLines).values(lines.map((line, i) => ({ id: newId('jl'), entryId, asset: 'POINTS' as const, sequence: i + 1, ...line })));
    });
    return entryId;
  }

  it('is clean after a settlement and after a void', async () => {
    const settled = await settledContest();
    const voidable = await openWithEntrants(runtime.db, arena);
    await voidContest(runtime.db, { tenantId: arena.tenantId, contestId: voidable.id, actor: OPERATOR, idempotencyKey: key() });
    const report = await reconcile(runtime.db);
    expect(report.ok).toBe(true);
    expect(report.invariants.find((r) => r.id === 'I4')?.detail).toBe('every one of 2 settled or voided contests has an empty escrow');
    expect(report.invariants.find((r) => r.id === 'I5')?.detail).toBe('results of every one of 1 settled contests sum to what it escrowed');
    expect(report.invariants.find((r) => r.id === 'I7')?.detail).toBe('every one of 6 participants links to a matching escrow entry');
    expect(settled.state).toBe('settled');
  });

  it('I4 catches a settled or voided contest whose escrow is not empty', async () => {
    const settled = await settledContest();
    // Value credited into the escrow after settlement, balanced against the promo account,
    // as a second `settle` entry so that I5's notion of "escrowed" is untouched and I4 stands alone.
    await inject(
      [
        { accountId: arena.promo.id, direction: 'debit', amount: 7n },
        { accountId: settled.escrowAccountId, direction: 'credit', amount: 7n },
      ],
      settled.id,
      'settle',
    );
    const report = await reconcile(runtime.db);
    expect(report.ok).toBe(false);
    expect(report.invariants.filter((r) => !r.ok).map((r) => r.id)).toEqual(['I4']);
    expect(report.invariants.find((r) => r.id === 'I4')?.detail).toBe(`1 settled or voided contests still hold escrow: ${settled.id} (settled) = 7`);
  });

  it('I5 catches results that do not sum to what was escrowed, whether a result was edited or the escrow history was', async () => {
    const settled = await settledContest();
    await migrator.sql`update contest_results set payout_amount = payout_amount + 1 where contest_id = ${settled.id} and placement = 1`;
    let report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok).map((r) => r.id)).toEqual(['I5']);
    expect(report.invariants.find((r) => r.id === 'I5')?.detail).toBe(`1 settled contests pay out something other than what they escrowed: ${settled.id} paid 301 of 300`);
    await migrator.sql`update contest_results set payout_amount = payout_amount - 1 where contest_id = ${settled.id} and placement = 1`;

    // An extra "escrow" credit and a matching debit back out keep I4 at zero but change what was escrowed.
    await inject(
      [
        { accountId: arena.promo.id, direction: 'debit', amount: 50n },
        { accountId: settled.escrowAccountId, direction: 'credit', amount: 50n },
      ],
      settled.id,
    );
    await inject(
      [
        { accountId: settled.escrowAccountId, direction: 'debit', amount: 50n },
        { accountId: arena.promo.id, direction: 'credit', amount: 50n },
      ],
      settled.id,
    );
    report = await reconcile(runtime.db);
    // Balanced in and out: escrowed is unchanged (credits less non-settle debits), so I5 is clean and so is I4.
    expect(report.ok).toBe(true);

    // But a settle-kind debit that was not the settlement changes what "escrowed" means and is caught.
    await inject(
      [
        { accountId: settled.escrowAccountId, direction: 'debit', amount: 1n },
        { accountId: arena.promo.id, direction: 'credit', amount: 1n },
      ],
      settled.id,
      'settle',
    );
    await inject(
      [
        { accountId: arena.promo.id, direction: 'debit', amount: 1n },
        { accountId: settled.escrowAccountId, direction: 'credit', amount: 1n },
      ],
      settled.id,
    );
    report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok).map((r) => r.id)).toEqual(['I5']);
    expect(report.invariants.find((r) => r.id === 'I5')?.detail).toContain(`${settled.id} paid 300 of 301`);
  });

  it('I7 catches an entry link that is not that user’s escrow entry for that contest, asset and amount', async () => {
    const contest = await openWithEntrants(runtime.db, arena);
    const participants = await runtime.db.query.contestParticipants.findMany({ where: (table, { eq }) => eq(table.contestId, contest.id) });
    const first = participants[0];
    if (first === undefined) throw new Error('expected participants');
    const relink = async (entryId: string) => {
      // The trigger and the column privilege forbid this; only the owner with the trigger disabled can.
      await migrator.db.transaction(async (tx) => {
        await tx.execute(sql`alter table contest_participants disable trigger contest_participants_guard`);
        await tx.execute(sql`update contest_participants set entry_journal_entry_id = ${entryId} where id = ${first.id}`);
        await tx.execute(sql`alter table contest_participants enable trigger contest_participants_guard`);
      });
    };
    const reamount = async (amount: number) => {
      await migrator.db.transaction(async (tx) => {
        await tx.execute(sql`alter table contests disable trigger contests_frozen_after_draft`);
        await tx.execute(sql`update contests set entry_amount = ${amount} where id = ${contest.id}`);
        await tx.execute(sql`alter table contests enable trigger contests_frozen_after_draft`);
      });
    };
    const failing = async () => {
      const report = await reconcile(runtime.db);
      expect(report.invariants.filter((r) => !r.ok).map((r) => r.id)).toEqual(['I7']);
      return report.invariants.find((r) => r.id === 'I7')?.detail ?? '';
    };

    // An escrow-kind entry for the contest and amount that debits the promo account, not the user's wallet.
    const wrongDebit = await inject(
      [
        { accountId: arena.promo.id, direction: 'debit', amount: 100n },
        { accountId: contest.escrowAccountId, direction: 'credit', amount: 100n },
      ],
      contest.id,
      'escrow',
    );
    await relink(wrongDebit);
    expect(await failing()).toBe(`1 participants do not link to a matching escrow entry: ${first.id} (${first.userId} in ${contest.id} -> ${wrongDebit})`);

    // The right entry, but the contest's amount no longer matches any of them.
    await relink(first.entryJournalEntryId);
    expect((await reconcile(runtime.db)).ok).toBe(true);
    await reamount(101);
    expect(await failing()).toMatch(/^3 participants do not link/);
    await reamount(100);

    // The right user and amount, the wrong kind: a promo issue is not an escrow.
    const wallet = await runtime.db.query.accounts.findFirst({ where: (table, { and, eq }) => and(eq(table.kind, 'user_wallet'), eq(table.ownerRef, first.userId)) });
    const issued = await issuePromoPoints(runtime.db, { tenantId: arena.tenantId, asset: 'POINTS', promoLiabilityAccountId: arena.promo.id, walletAccountId: wallet?.id ?? '', amount: 100n, idempotencyKey: key() });
    await relink(issued.entry.id);
    expect(await failing()).toContain(`-> ${issued.entry.id}`);

    // The right shape under another contest's id: the entry must carry this contest.
    const other = await openWithEntrants(runtime.db, arena);
    const otherEntry = (await runtime.db.query.contestParticipants.findFirst({ where: (table, { eq }) => eq(table.contestId, other.id) }))?.entryJournalEntryId ?? '';
    await relink(wrongDebit);
    await migrator.db.transaction(async (tx) => {
      await tx.execute(sql`alter table contest_participants disable trigger contest_participants_guard`);
      await tx.execute(sql`update contest_participants set entry_journal_entry_id = ${issued.entry.id} where entry_journal_entry_id = ${otherEntry}`);
      await tx.execute(sql`alter table contest_participants enable trigger contest_participants_guard`);
    });
    await relink(otherEntry);
    const detail = (await reconcile(runtime.db)).invariants.find((r) => r.id === 'I7')?.detail ?? '';
    expect(detail).toMatch(/^2 participants do not link/);
    expect(detail).toContain(`-> ${otherEntry}`);
  });
});
