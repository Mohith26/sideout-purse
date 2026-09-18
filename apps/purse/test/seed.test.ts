import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import type { Database } from '../src/db/client';
import { accounts, auditLog, tenants } from '../src/db/schema';
import { PLATFORM_ACCOUNT_KINDS, SIDEOUT_TENANT_ID, SIDEOUT_TENANT_NAME, seedPlatformAccounts, seedSideoutTenant } from '../src/db/seed';
import { connectMigrator } from './helpers';

describe('db:seed', () => {
  // The seed runs as the owner role, exactly as `pnpm db:seed` does.
  let database: Database;
  beforeAll(() => {
    database = connectMigrator();
  });
  beforeEach(async () => {
    await database.db.delete(auditLog);
    await database.db.delete(accounts);
    await database.db.delete(tenants);
  });
  afterAll(async () => {
    await database.db.delete(auditLog);
    await database.db.delete(accounts);
    await database.db.delete(tenants);
    await database.close();
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
});
