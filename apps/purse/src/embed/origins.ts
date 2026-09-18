import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { tenantOrigins, type TenantOrigin } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { EmbedError } from './errors';

/**
 * The per-tenant origin allowlist (spec 4.8 rule 3). Three readers: the embed app, which
 * refuses to talk to a parent that is not on its tenant's list; the session endpoint,
 * which refuses to redeem a token for a parent that is not; and the API's CORS layer,
 * which names an origin in `Access-Control-Allow-Origin` only if some tenant lists it.
 * The embed page's `frame-ancestors` is the union of every tenant's active origins.
 */
const ORIGIN_SHAPE = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;

/** An origin is a scheme, host and optional port, lower case, no path and no trailing slash. */
export function normaliseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmbedError('invalid_input', `${value} is not an origin`, { field: 'origin' });
  }
  const origin = url.origin.toLowerCase();
  if (url.origin === 'null' || origin !== value.toLowerCase().replace(/\/$/, '') || !ORIGIN_SHAPE.test(origin)) {
    throw new EmbedError('invalid_input', 'origin must be a scheme, host and optional port, such as https://sideout.example', { field: 'origin', value });
  }
  return origin;
}

export async function activeOrigins(db: DbOrTx, tenantId: Id<'tnt'>): Promise<string[]> {
  const rows = await db
    .select({ origin: tenantOrigins.origin })
    .from(tenantOrigins)
    .where(and(eq(tenantOrigins.tenantId, tenantId), isNull(tenantOrigins.revokedAt)))
    .orderBy(tenantOrigins.origin);
  return rows.map((row) => row.origin);
}

export async function isOriginAllowed(db: DbOrTx, tenantId: Id<'tnt'>, origin: string): Promise<boolean> {
  const [row] = await db
    .select({ origin: tenantOrigins.origin })
    .from(tenantOrigins)
    .where(and(eq(tenantOrigins.tenantId, tenantId), eq(tenantOrigins.origin, origin.toLowerCase()), isNull(tenantOrigins.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/** Every tenant's active origins, for the preflight that arrives before any key and for `frame-ancestors`. */
export async function allActiveOrigins(db: DbOrTx): Promise<string[]> {
  const rows = await db.select({ origin: tenantOrigins.origin }).from(tenantOrigins).where(isNull(tenantOrigins.revokedAt)).orderBy(tenantOrigins.origin);
  return [...new Set(rows.map((row) => row.origin))];
}

export type OriginInput = { tenantId: Id<'tnt'>; origin: string; actor?: Actor; requestId?: string };

/** Add an origin, or restore a revoked one. Idempotent. */
export async function addOrigin(db: DbOrTx, input: OriginInput): Promise<TenantOrigin> {
  const origin = normaliseOrigin(input.origin);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tenantOrigins).where(and(eq(tenantOrigins.tenantId, input.tenantId), eq(tenantOrigins.origin, origin))).for('update');
    if (before !== undefined && before.revokedAt === null) return before;
    const [after] =
      before === undefined
        ? await tx.insert(tenantOrigins).values({ tenantId: input.tenantId, origin }).returning()
        : await tx.update(tenantOrigins).set({ revokedAt: null }).where(and(eq(tenantOrigins.tenantId, input.tenantId), eq(tenantOrigins.origin, origin))).returning();
    if (after === undefined) throw new Error('tenant_origins write returned no row');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: before === undefined ? 'tenant_origin.added' : 'tenant_origin.restored',
      subject: `origin:${input.tenantId}:${origin}`,
      before: before ?? null,
      after,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}

/** Revoke an origin. Idempotent; an origin never listed is a no-op that returns undefined. */
export async function revokeOrigin(db: DbOrTx, input: OriginInput): Promise<TenantOrigin | undefined> {
  const origin = normaliseOrigin(input.origin);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tenantOrigins).where(and(eq(tenantOrigins.tenantId, input.tenantId), eq(tenantOrigins.origin, origin))).for('update');
    if (before === undefined) return undefined;
    if (before.revokedAt !== null) return before;
    const [after] = await tx
      .update(tenantOrigins)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(tenantOrigins.tenantId, input.tenantId), eq(tenantOrigins.origin, origin)))
      .returning();
    if (after === undefined) throw new Error('tenant_origins update returned no row');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'tenant_origin.revoked',
      subject: `origin:${input.tenantId}:${origin}`,
      before,
      after,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}
