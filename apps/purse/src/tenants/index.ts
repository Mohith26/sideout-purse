import { eq, sql } from 'drizzle-orm';
import type { ApiErrorType } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { tenants, type Tenant, type TenantStatus } from '../db/schema';
import { recordAudit, type Actor } from '../ledger/audit';

/**
 * Tenants (spec 4.1): one row per partner. The seed creates them; the console reads them
 * and may suspend or reinstate one, which is the one runtime change to a tenant (a
 * suspended tenant's keys stop authenticating at once, `src/auth/api-keys.ts`).
 */
export const TENANT_ERROR_CODES = { tenant_not_found: 'invalid_request' } as const satisfies Record<string, ApiErrorType>;

export class TenantError extends Error {
  override readonly name = 'TenantError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: keyof typeof TENANT_ERROR_CODES,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = TENANT_ERROR_CODES[code];
  }
}

export async function listTenants(db: DbOrTx): Promise<Tenant[]> {
  return db.select().from(tenants).orderBy(tenants.createdAt, tenants.id);
}

export async function getTenant(db: DbOrTx, tenantId: string): Promise<Tenant> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (row === undefined) throw new TenantError('tenant_not_found', `No tenant ${tenantId}`, { tenantId });
  return row;
}

export type SetTenantStatusInput = { tenantId: Id<'tnt'>; status: TenantStatus; reason?: string; actor: Actor; requestId?: string };

/** Suspend or reinstate. Setting the status a tenant already has changes nothing and audits nothing. */
export async function setTenantStatus(db: DbOrTx, input: SetTenantStatusInput): Promise<Tenant> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId)).for('update');
    if (before === undefined) throw new TenantError('tenant_not_found', `No tenant ${input.tenantId}`, { tenantId: input.tenantId });
    if (before.status === input.status) return before;
    if (before.status === 'retired') throw new TenantError('tenant_not_found', 'Retired sandboxes cannot be reinstated');
    const [after] = await tx.update(tenants).set({ status: input.status, updatedAt: sql`now()` }).where(eq(tenants.id, before.id)).returning();
    if (after === undefined) throw new Error(`tenants update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: before.id as Id<'tnt'>,
      actor: input.actor,
      action: input.status === 'suspended' ? 'tenant.suspended' : 'tenant.reinstated',
      subject: before.id,
      before: { status: before.status },
      after: { status: after.status, ...(input.reason === undefined ? {} : { reason: input.reason }) },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}
