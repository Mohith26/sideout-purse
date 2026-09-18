import { eq } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import { openAccount } from '../ledger/accounts';
import type { Db } from './client';
import { asset, tenants, type Account, type AccountKind, type Tenant } from './schema';

/**
 * Reference data Purse cannot run without, applied by `pnpm db:seed` after migrations.
 * Seed data never lives in migration history: migrations are forward-only and describe
 * the schema, this describes rows, and it may be re-run against any environment.
 *
 * Sideout's tenant id is a UUID v7 minted once so every environment agrees on it; phase 4
 * configures Sideout with the same value through its own environment, not by importing
 * this file.
 */
export const SIDEOUT_TENANT_ID: Id<'tnt'> = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9';
export const SIDEOUT_TENANT_NAME = 'Sideout';

export type SeedResult = { tenant: Tenant; created: boolean };

/**
 * Upsert the Sideout tenant, keyed on its unique name. A first run inserts the row with
 * the stable id; a later run leaves whatever is there alone (including an operator's
 * suspension) and reports it, so the script is safe to run on every deploy.
 */
export async function seedSideoutTenant(db: Db): Promise<SeedResult> {
  const [inserted] = await db
    .insert(tenants)
    .values({ id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME })
    .onConflictDoNothing({ target: tenants.name })
    .returning();
  if (inserted !== undefined) return { tenant: inserted, created: true };

  const [existing] = await db.select().from(tenants).where(eq(tenants.name, SIDEOUT_TENANT_NAME));
  if (existing === undefined) {
    throw new Error(`Tenant "${SIDEOUT_TENANT_NAME}" was neither inserted nor found`);
  }
  return { tenant: existing, created: false };
}

/**
 * The platform-level accounts every tenant has, one per asset (spec 4.2.1): the promo
 * liability points are issued from, the platform fee account (zero in v1 but modelled),
 * and the external settlement boundary redemptions leave through. `openAccount` is
 * idempotent on the unique key, so this creates nothing on a second run. User wallets and
 * contest escrows are opened on demand, never seeded.
 */
export const PLATFORM_ACCOUNT_KINDS: readonly AccountKind[] = ['promo_liability', 'platform_fee', 'external_settlement'];

export type PlatformAccountsResult = { accounts: Account[]; created: number };

export async function seedPlatformAccounts(db: Db, tenantId: string): Promise<PlatformAccountsResult> {
  const opened: Account[] = [];
  let created = 0;
  for (const kind of PLATFORM_ACCOUNT_KINDS) {
    for (const each of asset.enumValues) {
      const result = await openAccount(db, { tenantId: tenantId as Id<'tnt'>, kind, ownerRef: null, asset: each });
      opened.push(result.account);
      if (result.created) created += 1;
    }
  }
  return { accounts: opened, created };
}
