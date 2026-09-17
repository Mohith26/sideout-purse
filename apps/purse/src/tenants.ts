import type { Id } from '@repo/ids';

/**
 * Sideout's tenant row. Seeded by migration `0001_seed_sideout_tenant` with this exact id
 * so every environment agrees on it; Sideout is configured with the same value in phase 4
 * (`Purse.init({ tenantId })`) through its own environment, not by importing this file.
 *
 * The UUID is a v7 minted once at the time of the seed migration; its timestamp is the
 * moment the tenant was created, like any other id.
 */
export const SIDEOUT_TENANT_ID: Id<'tnt'> = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9';
export const SIDEOUT_TENANT_NAME = 'Sideout';
