import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ecPublicJwkSchema, jwkThumbprint, type EcPublicJwk } from '@purse/types';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { userDevices, type UserDevice } from '../db/schema';
import { recordAudit, type Actor } from '../ledger/audit';
import { UsersError } from './errors';
import { actorRef } from './restrictions';
import { getUser } from './users';

/**
 * Registered devices (spec section 12, item 1; `@purse/types` `attestation.ts`): the
 * public keys a partner registers against a user so a score's signature can be checked
 * against Purse's own copy. The key id is the JWK thumbprint, computed here from the key
 * and never taken from the request. Registering a key the user already holds live is a
 * no-op that returns the existing row (the idempotent shape a re-registration wants), and
 * a revoked key may be registered again as a new row. Revocation is the one update and is
 * never undone. Every write audits.
 */
export type RegisterDeviceInput = {
  tenantId: Id<'tnt'>;
  userId: string;
  publicKey: EcPublicJwk;
  label?: string | null;
  actor: Actor;
  requestId?: string;
};

export type RegisteredDevice = { device: UserDevice; created: boolean };

const LABEL_MAX = 120;
const REASON_MAX = 500;

export async function registerDevice(db: DbOrTx, input: RegisterDeviceInput): Promise<RegisteredDevice> {
  const parsed = ecPublicJwkSchema.safeParse(input.publicKey);
  if (!parsed.success) throw new UsersError('invalid_input', 'publicKey must be a P-256 public JWK (kty EC, crv P-256, x, y) and nothing else', { field: 'publicKey' });
  const label = input.label ?? null;
  if (label !== null && (label.trim() === '' || label.length > LABEL_MAX)) {
    throw new UsersError('invalid_input', `label must be 1 to ${LABEL_MAX} characters when given`, { field: 'label' });
  }
  const keyId = await jwkThumbprint(parsed.data);
  return db.transaction(async (tx) => {
    const user = await getUser(tx, input.tenantId, input.userId);
    const [existing] = await tx
      .select()
      .from(userDevices)
      .where(and(eq(userDevices.userId, user.id), eq(userDevices.keyId, keyId), isNull(userDevices.revokedAt)))
      .for('update');
    if (existing !== undefined) return { device: existing, created: false };
    const [row] = await tx
      .insert(userDevices)
      .values({ id: newId('udv'), userId: user.id, keyId, algorithm: 'ES256', publicKey: parsed.data, label, createdBy: actorRef(input.actor) })
      .returning();
    if (row === undefined) throw new Error('user_devices insert returned no row');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'user.device.registered',
      subject: row.id,
      before: null,
      after: row,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { device: row, created: true };
  });
}

export type RevokeDeviceInput = {
  tenantId: Id<'tnt'>;
  userId: string;
  deviceId: string;
  reason?: string | null;
  actor: Actor;
  requestId?: string;
};

/** Revoke a device: a score signed with its key is refused from now on. Idempotent: an already revoked device is returned as it is. */
export async function revokeDevice(db: DbOrTx, input: RevokeDeviceInput): Promise<{ device: UserDevice; revoked: boolean }> {
  if (!isId(input.deviceId, 'udv')) throw new UsersError('invalid_input', 'deviceId must be a udv_ id', { field: 'deviceId' });
  const reason = input.reason ?? null;
  if (reason !== null && (reason.trim() === '' || reason.length > REASON_MAX)) {
    throw new UsersError('invalid_input', `reason must be 1 to ${REASON_MAX} characters when given`, { field: 'reason' });
  }
  return db.transaction(async (tx) => {
    const user = await getUser(tx, input.tenantId, input.userId);
    const [before] = await tx.select().from(userDevices).where(and(eq(userDevices.id, input.deviceId), eq(userDevices.userId, user.id))).for('update');
    if (before === undefined) throw new UsersError('device_not_found', `No device ${input.deviceId} for user ${user.id}`, { deviceId: input.deviceId, userId: user.id });
    if (before.revokedAt !== null) return { device: before, revoked: false };
    const [after] = await tx
      .update(userDevices)
      .set({ revokedAt: sql`now()`, revokedBy: actorRef(input.actor), revokedReason: reason, updatedAt: sql`now()` })
      .where(eq(userDevices.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`user_devices update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'user.device.revoked',
      subject: before.id,
      before,
      after,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { device: after, revoked: true };
  });
}

/** Every device ever registered for a user, oldest first, revoked ones included. */
export async function listDevices(db: DbOrTx, tenantId: Id<'tnt'>, userId: string): Promise<UserDevice[]> {
  const user = await getUser(db, tenantId, userId);
  return db.select().from(userDevices).where(eq(userDevices.userId, user.id)).orderBy(asc(userDevices.createdAt), asc(userDevices.id));
}

/** The user's live (unrevoked) device under a key id, or the revoked one if that is all there is, or null. */
export async function findDeviceByKey(db: DbOrTx, userId: string, keyId: string): Promise<UserDevice | null> {
  const rows = await db
    .select()
    .from(userDevices)
    .where(and(eq(userDevices.userId, userId), eq(userDevices.keyId, keyId)))
    .orderBy(asc(userDevices.createdAt), asc(userDevices.id));
  return rows.find((row) => row.revokedAt === null) ?? rows.at(-1) ?? null;
}
