import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';
import type { ApiErrorEnvelope } from '@purse/types';

import type { Database } from '../../src/db/client';
import { journalEntries, journalLines } from '../../src/db/schema';
import { escrowEntry, INVARIANTS, issuePromoPoints, reconcile, settleEscrow, type ReconcileReport } from '../../src/ledger';
import { connectMigrator, connectRuntime, harness } from '../helpers';
import { buildWorld, key, wipeLedger, type World } from './fixtures';

/**
 * Spec 4.2.4. `reconcile()` reports every invariant, catches corruption that the runtime
 * role could never cause (injected here as the owner, bypassing the service), and is
 * exposed at `GET /internal/reconcile` behind a bearer token.
 */
describe('reconcile()', () => {
  let migrator: Database;
  let runtime: Database;
  let world: World;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    world = await buildWorld(runtime.db, { wallets: 2, escrows: 1 });
  });
  afterAll(async () => {
    await migrator.sql`drop table if exists account_balance_snapshots`;
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const wallet = (i: number) => world.wallets[i]?.id ?? '';

  async function post(): Promise<void> {
    const common = { tenantId: world.tenantId, asset: 'POINTS' as const };
    await issuePromoPoints(runtime.db, { ...common, promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(0), amount: 100n, idempotencyKey: key() });
    await issuePromoPoints(runtime.db, { ...common, promoLiabilityAccountId: world.promo.id, walletAccountId: wallet(1), amount: 100n, idempotencyKey: key() });
    await escrowEntry(runtime.db, { ...common, walletAccountId: wallet(0), escrowAccountId: world.escrows[0]?.id ?? '', amount: 40n, idempotencyKey: key() });
    await escrowEntry(runtime.db, { ...common, walletAccountId: wallet(1), escrowAccountId: world.escrows[0]?.id ?? '', amount: 40n, idempotencyKey: key() });
    await settleEscrow(runtime.db, { ...common, escrowAccountId: world.escrows[0]?.id ?? '', payouts: [{ walletAccountId: wallet(0), amount: 80n }], idempotencyKey: key() });
  }

  /**
   * A raw, unbalanced write, as the owner, with the commit-time balance trigger switched
   * off for that one transaction (only the owner can): the corruption the service, the
   * role and the trigger make impossible, and the reason `reconcile()` exists anyway.
   */
  async function corrupt(lines: Array<{ accountId: string; direction: 'debit' | 'credit'; amount: bigint }>): Promise<string> {
    const entryId = newId('je');
    await migrator.db.transaction(async (tx) => {
      await tx.execute(sql`alter table journal_lines disable trigger journal_lines_entry_balanced`);
      await tx.insert(journalEntries).values({ id: entryId, tenantId: world.tenantId, kind: 'adjustment', description: 'corrupt', idempotencyKey: key('corrupt'), requestHash: 'x' });
      if (lines.length > 0) {
        await tx.insert(journalLines).values(lines.map((line, i) => ({ id: newId('jl'), entryId, asset: 'POINTS' as const, sequence: i + 1, ...line })));
      }
      await tx.execute(sql`alter table journal_lines enable trigger journal_lines_entry_balanced`);
    });
    return entryId;
  }

  it('reports all seven invariants every time, each checked, none not-applicable', async () => {
    await post();
    const report = await reconcile(runtime.db);
    expect(report.ok).toBe(true);
    expect(report.invariants.map((r) => r.id)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
    expect(INVARIANTS.map((r) => r.id)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
    for (const result of report.invariants) {
      expect(result.ok).toBe(true);
      expect(result.detail.length).toBeGreaterThan(0);
      expect(result.status).toBe('ok');
      expect(result.notApplicableUntil).toBeUndefined();
    }
    expect(report.invariants.find((r) => r.id === 'I1')?.detail).toMatch(/POINTS: debits 360, credits 360/);
    expect(report.invariants.find((r) => r.id === 'I2')?.detail).toMatch(/every one of 5 entries/);
    expect(report.invariants.find((r) => r.id === 'I3')?.detail).toMatch(/none of 2 user wallets/);
    expect(report.invariants.find((r) => r.id === 'I4')?.detail).toMatch(/every one of 0 settled or voided contests/);
    expect(report.invariants.find((r) => r.id === 'I5')?.detail).toMatch(/every one of 0 settled contests/);
    expect(report.invariants.find((r) => r.id === 'I6')?.detail).toMatch(/no account_balance_snapshots table/);
    expect(report.invariants.find((r) => r.id === 'I7')?.detail).toMatch(/every one of 0 participants/);
    expect(Date.parse(report.ranAt)).not.toBeNaN();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('I1 and I2 catch an entry that does not balance, one with a single line, and one with none', async () => {
    await post();
    const unbalanced = await corrupt([
      { accountId: world.promo.id, direction: 'debit', amount: 10n },
      { accountId: wallet(0), direction: 'credit', amount: 7n },
    ]);
    let report = await reconcile(runtime.db);
    expect(report.ok).toBe(false);
    expect(report.invariants.filter((r) => !r.ok).map((r) => r.id)).toEqual(['I1', 'I2']);
    expect(report.invariants.find((r) => r.id === 'I1')?.detail).toMatch(/does not net to zero for POINTS \(POINTS: debits 370, credits 367\)/);
    expect(report.invariants.find((r) => r.id === 'I2')?.detail).toContain(`${unbalanced} (lines 2, assets 1, debits-credits 3)`);

    const lonely = await corrupt([{ accountId: world.fee.id, direction: 'credit', amount: 3n }]);
    const empty = await corrupt([]);
    report = await reconcile(runtime.db);
    // The lonely credit of 3 happens to restore I1; I2 still names all three broken entries.
    expect(report.invariants.find((r) => r.id === 'I1')?.ok).toBe(true);
    const i2 = report.invariants.find((r) => r.id === 'I2');
    expect(i2?.ok).toBe(false);
    expect(i2?.detail).toMatch(/^3 entries do not balance/);
    expect(i2?.detail).toContain(`${lonely} (lines 1`);
    expect(i2?.detail).toContain(`${empty} (lines 0`);
  });

  it('I3 catches a wallet driven negative behind the service’s back', async () => {
    await post();
    await corrupt([
      { accountId: wallet(1), direction: 'debit', amount: 500n },
      { accountId: world.fee.id, direction: 'credit', amount: 500n },
    ]);
    const report = await reconcile(runtime.db);
    const i3 = report.invariants.find((r) => r.id === 'I3');
    expect(i3?.ok).toBe(false);
    expect(i3?.detail).toBe(`1 user wallets are negative: ${wallet(1)}=-440`);
    // The balanced corrupt entry keeps I1 and I2 clean: I3 is its own check. I9 fires
    // too, and correctly: the corruption credits the platform fee account outside a `fee`
    // entry, which is exactly the tampering I9 exists to notice.
    expect(report.invariants.filter((r) => !r.ok).map((r) => r.id)).toEqual(['I3', 'I9']);
  });

  it('I6 compares snapshots to derived balances once a snapshot table exists', async () => {
    await post();
    const [asOf] = await runtime.db.select().from(journalEntries).orderBy(journalEntries.postedAt).limit(1);
    // The table is a later phase's; create the spec's shape as the owner and let the runtime read it.
    await migrator.sql`create table if not exists account_balance_snapshots (
      account_id text not null references accounts(id),
      as_of_entry_id text not null references journal_entries(id),
      balance bigint not null,
      computed_at timestamptz not null default now()
    )`;
    await migrator.sql`grant select on account_balance_snapshots to purse_app`;
    try {
      // After the first entry (issue 100 to wallet 0) the wallet held 100 and promo -100.
      await migrator.sql`insert into account_balance_snapshots (account_id, as_of_entry_id, balance) values
        (${wallet(0)}, ${asOf?.id ?? ''}, 100), (${world.promo.id}, ${asOf?.id ?? ''}, -100)`;
      let report = await reconcile(runtime.db);
      expect(report.invariants.find((r) => r.id === 'I6')).toMatchObject({ ok: true, detail: 'all 2 snapshots equal their derived balance' });

      await migrator.sql`insert into account_balance_snapshots (account_id, as_of_entry_id, balance) values (${wallet(1)}, ${asOf?.id ?? ''}, 1)`;
      report = await reconcile(runtime.db);
      expect(report.ok).toBe(false);
      expect(report.invariants.find((r) => r.id === 'I6')?.detail).toBe(`1 snapshots diverge: ${wallet(1)} snapshot 1 vs derived 0`);
    } finally {
      await migrator.sql`drop table account_balance_snapshots`;
    }
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });
});

describe('GET /internal/reconcile', () => {
  let migrator: Database;
  beforeAll(async () => {
    migrator = connectMigrator();
    await wipeLedger(migrator);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
  });

  it('is open without a token only under NODE_ENV=test', async () => {
    const h = harness();
    try {
      const res = await h.app.request('/internal/reconcile');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: ReconcileReport };
      expect(body.data.ok).toBe(true);
      expect(body.data.invariants).toHaveLength(9);
      expect(h.lines.some((l) => l['msg'] === 'reconcile clean')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('requires the exact bearer token when one is configured', async () => {
    const token = 'internal-token-for-tests-0123456789';
    const h = harness({ internalApiToken: token });
    try {
      const noHeader = await h.app.request('/internal/reconcile');
      expect(noHeader.status).toBe(401);
      expect(((await noHeader.json()) as ApiErrorEnvelope).error).toEqual({ type: 'authentication_error', code: 'invalid_internal_token', message: 'A valid bearer token is required' });
      const wrong = await h.app.request('/internal/reconcile', { headers: { Authorization: `Bearer ${token.slice(0, -1)}x` } });
      expect(wrong.status).toBe(401);
      const basic = await h.app.request('/internal/reconcile', { headers: { Authorization: `Basic ${token}` } });
      expect(basic.status).toBe(401);
      const right = await h.app.request('/internal/reconcile', { headers: { Authorization: `Bearer ${token}` } });
      expect(right.status).toBe(200);
      expect(h.lines.some((l) => JSON.stringify(l).includes(token))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('answers 500 in the error envelope, with the report, when an invariant fails', async () => {
    const h = harness();
    try {
      const tenantId = newId('tnt');
      await migrator.sql`insert into tenants (id, name) values (${tenantId}, ${`t-${tenantId}`})`;
      const entryId = newId('je');
      await migrator.db.insert(journalEntries).values({ id: entryId, tenantId, kind: 'adjustment', description: 'corrupt', idempotencyKey: key(), requestHash: 'x' });

      const res = await h.app.request('/internal/reconcile');
      expect(res.status).toBe(500);
      const body = (await res.json()) as ApiErrorEnvelope;
      expect(body.error.type).toBe('internal_error');
      expect(body.error.code).toBe('invariant_violation');
      expect(body.error.message).toBe('1 invariant(s) failed: I2');
      const report = body.error.detail as ReconcileReport;
      expect(report.ok).toBe(false);
      expect(report.invariants.find((r) => r.id === 'I2')?.detail).toContain(entryId);
      expect(h.lines.some((l) => l['msg'] === 'reconcile failed' && l['level'] === 'error')).toBe(true);
    } finally {
      await h.close();
    }
  });
});
