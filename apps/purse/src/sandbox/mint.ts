import { and, eq, gt, sql } from 'drizzle-orm';
import type { SandboxKeysResource } from '@purse/types';
import { newId } from '@repo/ids';

import { createApiKey } from '../auth/api-keys';
import type { Db } from '../db/client';
import { sandboxLeases, tenants } from '../db/schema';
import { addOrigin } from '../embed/origins';
import { ApiFailure } from '../http/envelope';
import { recordAudit, SYSTEM_ACTOR } from '../ledger/audit';

export const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const SANDBOX_PER_ADDRESS = 3;


/** Address lock makes the persistent limit and return-once receipt atomic across replicas. */
export async function mintSandbox(db: Db, input: { address: string; requestKey: string; origin: string; now: Date }): Promise<SandboxKeysResource> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox:${input.address}`}, 0))`);
    const [prior] = await tx.select().from(sandboxLeases).where(and(eq(sandboxLeases.address, input.address), eq(sandboxLeases.requestKey, input.requestKey)));
    if (prior !== undefined) {
      if (prior.origin !== input.origin) throw new ApiFailure({ type: 'conflict', code: 'idempotency_key_reused', message: 'This mint key was used on a different origin' });
      return { tenantId: prior.tenantId, secretKey: null, publishableKey: null, expiresAt: prior.expiresAt.toISOString(), replayed: true };
    }
    const live = await tx.select({ tenantId: sandboxLeases.tenantId }).from(sandboxLeases)
      .where(and(eq(sandboxLeases.address, input.address), gt(sandboxLeases.expiresAt, input.now)));
    if (live.length >= SANDBOX_PER_ADDRESS) {
      throw new ApiFailure({ type: 'rate_limited', code: 'sandbox_limit', message: 'At most three sandboxes may be minted per address in 24 hours' });
    }
    const tenantId = newId('tnt');
    const expiresAt = new Date(input.now.getTime() + SANDBOX_TTL_MS);
    await tx.insert(tenants).values({ id: tenantId, name: `sandbox-${tenantId}` });
    await tx.insert(sandboxLeases).values({ tenantId, address: input.address, requestKey: input.requestKey, origin: input.origin, expiresAt });
    await recordAudit(tx, { tenantId, actor: SYSTEM_ACTOR, action: 'sandbox.created', subject: tenantId, before: null, after: { expiresAt: expiresAt.toISOString() } });
    await addOrigin(tx, { tenantId, origin: input.origin, actor: SYSTEM_ACTOR });
    const secret = await createApiKey(tx, { tenantId, kind: 'secret', environment: 'sandbox', scopes: ['operator'], expiresAt });
    const publishable = await createApiKey(tx, { tenantId, kind: 'publishable', environment: 'sandbox', expiresAt });
    return { tenantId, secretKey: secret.plaintext, publishableKey: publishable.plaintext, expiresAt: expiresAt.toISOString(), replayed: false };
  });
}
