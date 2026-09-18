import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import { listParticipants, listResults } from '../src/contests';
import type { Database } from '../src/db/client';
import { accounts, auditLog, contests, tenants } from '../src/db/schema';
import {
  PLATFORM_ACCOUNT_KINDS,
  SEED_CONTESTS,
  SEED_USER_IDS,
  SIDEOUT_TENANT_ID,
  SIDEOUT_TENANT_NAME,
  seedContests,
  seedPlatformAccounts,
  seedSideoutTenant,
} from '../src/db/seed';
import { balanceOf, findAccount, reconcile } from '../src/ledger';
import { connectMigrator, connectRuntime } from './helpers';
import { wipeLedger } from './ledger/fixtures';

describe('db:seed', () => {
  // The seed runs as the owner role, exactly as `pnpm db:seed` does.
  let database: Database;
  let runtime: Database;
  beforeAll(() => {
    database = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(database);
  });
  afterAll(async () => {
    await wipeLedger(database);
    await database.close();
    await runtime.close();
  });

  it('creates the Sideout tenant with its stable id on an empty database', async () => {
    const result = await seedSideoutTenant(database.db);
    expect(result.created).toBe(true);
    expect(result.tenant).toMatchObject({ id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME, status: 'active' });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing and reports the row already present', async () => {
    const first = await seedSideoutTenant(database.db);
    const second = await seedSideoutTenant(database.db);
    expect(second).toEqual({ tenant: first.tenant, created: false });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('keys on the name, so an existing Sideout tenant is kept as is rather than duplicated', async () => {
    const existingId = newId('tnt');
    await database.db.insert(tenants).values({ id: existingId, name: SIDEOUT_TENANT_NAME, status: 'suspended' });

    const result = await seedSideoutTenant(database.db);
    expect(result.created).toBe(false);
    expect(result.tenant).toMatchObject({ id: existingId, name: SIDEOUT_TENANT_NAME, status: 'suspended' });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('opens the platform accounts per asset once, with no user wallets', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    const first = await seedPlatformAccounts(database.db, tenant.id);
    expect(first.created).toBe(PLATFORM_ACCOUNT_KINDS.length * 2);
    expect(first.accounts).toHaveLength(PLATFORM_ACCOUNT_KINDS.length * 2);

    const keys = first.accounts.map((account) => `${account.kind}/${account.asset}`).sort();
    expect(keys).toEqual(
      ['promo_liability', 'platform_fee', 'external_settlement'].flatMap((kind) => [`${kind}/CREDIT`, `${kind}/POINTS`]).sort(),
    );
    for (const account of first.accounts) {
      expect(account.tenantId).toBe(tenant.id);
      expect(account.ownerRef).toBeNull();
      expect(account.status).toBe('open');
      expect(account.kind).not.toBe('user_wallet');
    }
    // Normal sides follow the spec table.
    expect(first.accounts.find((a) => a.kind === 'promo_liability')?.normalSide).toBe('credit');
    expect(first.accounts.find((a) => a.kind === 'external_settlement')?.normalSide).toBe('debit');

    // Idempotent: the same six rows, nothing new, and one audit row per account opened.
    const second = await seedPlatformAccounts(database.db, tenant.id);
    expect(second.created).toBe(0);
    expect(second.accounts.map((a) => a.id).sort()).toEqual(first.accounts.map((a) => a.id).sort());
    expect(await database.db.select().from(accounts)).toHaveLength(PLATFORM_ACCOUNT_KINDS.length * 2);
    const audit = await database.db.select().from(auditLog);
    expect(audit).toHaveLength(PLATFORM_ACCOUNT_KINDS.length * 2);
    expect(audit.every((row) => row.action === 'account.opened' && row.actorKind === 'system')).toBe(true);
  });

  it('seeds one contest per reachable state, idempotently, and the settled one reconciles', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    await seedPlatformAccounts(database.db, tenant.id);
    const first = await seedContests(database.db, tenant.id as Id<'tnt'>);
    expect(first.contests.map((c) => [c.externalId, c.state, c.created])).toEqual([
      [SEED_CONTESTS.draft, 'draft', true],
      [SEED_CONTESTS.open, 'open', true],
      [SEED_CONTESTS.settled, 'settled', true],
    ]);

    const open = first.contests.find((c) => c.externalId === SEED_CONTESTS.open);
    const openParticipants = await listParticipants(runtime.db, open?.id ?? '');
    expect(openParticipants.map((p) => p.userId)).toEqual(SEED_USER_IDS.slice(0, 4));
    const [openRow] = await runtime.db.select().from(contests).where(eq(contests.id, open?.id ?? ''));
    expect(await balanceOf(runtime.db, openRow?.escrowAccountId ?? '')).toBe(400n);
    for (const userId of SEED_USER_IDS.slice(0, 4)) {
      const wallet = await findAccount(runtime.db, { tenantId: tenant.id as Id<'tnt'>, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS' });
      // 1000 issued, 100 into the open contest, and for the first five also 100 into the settled one plus its payout.
      expect(await balanceOf(runtime.db, wallet?.id ?? '')).toBeGreaterThanOrEqual(800n);
    }

    const settled = first.contests.find((c) => c.externalId === SEED_CONTESTS.settled);
    const results = await listResults(runtime.db, settled?.id ?? '');
    // 21, 18, 18, 15 and a no-show under 50/30/20 of 500: 250, then 150 + 100 shared -> 125 each, 0, 0.
    expect(results.map((r) => [r.placement, r.score, r.payoutAmount])).toEqual([
      [1, 21, 250n],
      [2, 18, 125n],
      [2, 18, 125n],
      [4, 15, 0n],
      [5, null, 0n],
    ]);
    expect(results.reduce((sum, r) => sum + r.payoutAmount, 0n)).toBe(500n);
    const [settledRow] = await runtime.db.select().from(contests).where(eq(contests.id, settled?.id ?? ''));
    expect(await balanceOf(runtime.db, settledRow?.escrowAccountId ?? '')).toBe(0n);
    expect(settledRow?.settledAt).toBeInstanceOf(Date);

    const report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok)).toEqual([]);

    // A second run creates nothing.
    const second = await seedContests(database.db, tenant.id as Id<'tnt'>);
    expect(second.contests.map((c) => [c.id, c.created])).toEqual(first.contests.map((c) => [c.id, false]));
    expect(await database.db.select().from(contests)).toHaveLength(3);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });
});
