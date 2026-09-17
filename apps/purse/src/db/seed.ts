import { eq } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { Db } from './client';
import { tenants, type Tenant } from './schema';

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
