import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { accounts, auditLog, NORMAL_SIDE_BY_KIND } from '../../src/db/schema';
import { balanceOf, findAccount, getAccount, isLedgerError, openAccount } from '../../src/ledger';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { createTenant, createUser, wipeLedger } from './fixtures';

describe('accounts (spec 4.2.1)', () => {
  let migrator: Database;
  let runtime: Database;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 6 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('openAccount is idempotent on (tenant, kind, owner, asset), including NULL owners, and audits the open', async () => {
    const tenantId = await createTenant(runtime.db);
    const userId = (await createUser(runtime.db, tenantId)).id;
    const first = await openAccount(runtime.db, { tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS', actor: { kind: 'tenant', ref: 'key_1' }, requestId: 'req-1' });
    const second = await openAccount(runtime.db, { tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ account: first.account, created: false });
    expect(first.account).toMatchObject({ kind: 'user_wallet', normalSide: 'credit', asset: 'POINTS', status: 'open', ownerRef: userId, userId });

    // The same user's CREDIT wallet is a different account.
    const credit = await openAccount(runtime.db, { tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'CREDIT' });
    expect(credit.created).toBe(true);

    // Platform singletons: NULL owners collapse to one row per (tenant, kind, asset).
    const promo1 = await openAccount(runtime.db, { tenantId, kind: 'promo_liability', ownerRef: null, asset: 'POINTS' });
    const promo2 = await openAccount(runtime.db, { tenantId, kind: 'promo_liability', ownerRef: null, asset: 'POINTS' });
    expect(promo2.created).toBe(false);
    expect(promo2.account.id).toBe(promo1.account.id);
    expect(await findAccount(runtime.db, { tenantId, kind: 'promo_liability', ownerRef: null, asset: 'POINTS' })).toEqual(promo1.account);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, first.account.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenantId, actorKind: 'tenant', actorRef: 'key_1', action: 'account.opened', before: null, requestId: 'req-1' });
    expect(audit[0]?.after).toMatchObject({ id: first.account.id, kind: 'user_wallet' });
    expect(await runtime.db.select().from(auditLog)).toHaveLength(3);
  });

  it('many concurrent opens of one wallet produce exactly one account', async () => {
    const tenantId = await createTenant(runtime.db);
    const userId = (await createUser(runtime.db, tenantId)).id;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => openAccount(runtime.db, { tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS' })),
    );
    const ids = new Set(results.map((r) => r.account.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await runtime.db.select().from(accounts)).toHaveLength(1);
  });

  it('every kind opens with the spec’s normal side and the database refuses any other', async () => {
    const tenantId = await createTenant(runtime.db);
    const userId = (await createUser(runtime.db, tenantId)).id;
    for (const [kind, normalSide] of Object.entries(NORMAL_SIDE_BY_KIND) as Array<[keyof typeof NORMAL_SIDE_BY_KIND, 'debit' | 'credit']>) {
      const ownerRef = kind === 'user_wallet' ? userId : kind === 'contest_escrow' ? newId('cnt') : null;
      const { account } = await openAccount(runtime.db, { tenantId, kind, ownerRef, asset: 'POINTS' });
      expect(account.normalSide).toBe(normalSide);
      expect(await balanceOf(runtime.db, account.id)).toBe(0n);
    }
    const flipped = await migrator.db
      .insert(accounts)
      .values({ id: newId('acct'), tenantId, kind: 'user_wallet', ownerRef: userId, userId, asset: 'CREDIT', normalSide: 'debit' })
      .then(() => undefined, (error: unknown) => String((error as Error).cause));
    expect(flipped).toMatch(/accounts_normal_side_by_kind/);
  });

  it('a wallet needs a user id and an escrow a contest id, checked by the database', async () => {
    const tenantId = await createTenant(runtime.db);
    const userId = (await createUser(runtime.db, tenantId)).id;
    const attempt = (values: Partial<typeof accounts.$inferInsert>) =>
      migrator.db
        .insert(accounts)
        .values({ id: newId('acct'), tenantId, kind: 'user_wallet', ownerRef: userId, userId, asset: 'POINTS', normalSide: 'credit', ...values })
        .then(() => undefined, (error: unknown) => String((error as Error).cause));
    expect(await attempt({ ownerRef: null, userId: null })).toMatch(/accounts_(owner_ref_by_kind|user_id_is_wallet_owner)/);
    expect(await attempt({ ownerRef: newId('cnt'), userId: null })).toMatch(/accounts_(owner_ref_by_kind|user_id_is_wallet_owner)/);
    expect(await attempt({ kind: 'contest_escrow', ownerRef: userId, userId: null })).toMatch(/accounts_owner_ref_by_kind/);
    expect(await attempt({ kind: 'contest_escrow', ownerRef: newId('cnt'), userId: null })).toBeUndefined();
    expect(await attempt({ id: 'acct_nope' })).toMatch(/accounts_id_prefix/);
    // The wallet's owner is a real foreign key (phase 3): `user_id` must name an existing
    // user and must equal `owner_ref`; an escrow carries no user.
    const ghost = newId('usr');
    expect(await attempt({ ownerRef: ghost, userId: ghost })).toMatch(/accounts_user_id_users_id_fk/);
    expect(await attempt({ userId: null })).toMatch(/accounts_user_id_is_wallet_owner/);
    const other = (await createUser(runtime.db, tenantId)).id;
    expect(await attempt({ userId: other })).toMatch(/accounts_user_id_is_wallet_owner/);
    expect(await attempt({ kind: 'contest_escrow', ownerRef: newId('cnt'), userId })).toMatch(/accounts_user_id_is_wallet_owner/);
  });

  it('getAccount and balanceOf refuse an unknown id rather than answering zero', async () => {
    const missing = await rejection(getAccount(runtime.db, newId('acct')));
    expect(isLedgerError(missing, 'account_not_found')).toBe(true);
    const balance = await rejection(balanceOf(runtime.db, newId('acct')));
    expect(isLedgerError(balance, 'account_not_found')).toBe(true);
  });
});
