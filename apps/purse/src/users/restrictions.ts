import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { userRestrictions, type RestrictionKind, type UserRestriction } from '../db/schema';
import { recordAudit, type Actor } from '../ledger/audit';
import { UsersError } from './errors';
import { getUser } from './users';

/**
 * Restrictions (spec 4.1, 4.6): self-exclusion and cool-off set by the user (irreversible
 * by them for the duration), platform blocks set by an operator, velocity locks set by the
 * platform. All are honoured by the evaluator before every entry. Phase 3 exposes these as
 * services; the responsible-play flow (phase 4) and the operator console (phase 5) are
 * their callers.
 */
export type AddRestrictionInput = {
  tenantId: Id<'tnt'>;
  userId: string;
  kind: RestrictionKind;
  reason?: string | null;
  startsAt?: Date;
  /** Required for `cool_off` and `velocity_lock`, which are temporary by definition. */
  endsAt?: Date | null;
  actor: Actor;
  requestId?: string;
};

const REASON_MAX = 500;

/** Kinds a user may place on themselves; the rest take an operator or the platform. */
const USER_PLACEABLE: ReadonlySet<RestrictionKind> = new Set<RestrictionKind>(['self_exclusion', 'cool_off']);
const TEMPORARY: ReadonlySet<RestrictionKind> = new Set<RestrictionKind>(['cool_off', 'velocity_lock']);

export function actorRef(actor: Actor): string {
  return actor.ref === undefined ? actor.kind : `${actor.kind}:${actor.ref}`;
}

/** Whether the user placed this restriction on themself (`created_by` is `user:<id>`), as opposed to an operator or the platform. */
export function placedByUser(restriction: Pick<UserRestriction, 'createdBy'>): boolean {
  return restriction.createdBy.startsWith('user:');
}

export async function addRestriction(db: DbOrTx, input: AddRestrictionInput): Promise<UserRestriction> {
  const reason = input.reason ?? null;
  if (reason !== null && (reason.trim() === '' || reason.length > REASON_MAX)) {
    throw new UsersError('invalid_input', `reason must be 1 to ${REASON_MAX} characters when given`, { field: 'reason' });
  }
  if (input.actor.kind === 'user' && !USER_PLACEABLE.has(input.kind)) {
    throw new UsersError('restriction_lift_forbidden', `A user cannot place a ${input.kind} on an account`, { kind: input.kind });
  }
  const startsAt = input.startsAt ?? new Date();
  const endsAt = input.endsAt ?? null;
  if (TEMPORARY.has(input.kind) && endsAt === null) {
    throw new UsersError('invalid_input', `${input.kind} is temporary and needs an endsAt`, { field: 'endsAt', kind: input.kind });
  }
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    throw new UsersError('invalid_input', 'endsAt must be after startsAt', { field: 'endsAt' });
  }

  return db.transaction(async (tx) => {
    const user = await getUser(tx, input.tenantId, input.userId);
    const [row] = await tx
      .insert(userRestrictions)
      .values({ id: newId('rst'), userId: user.id, kind: input.kind, reason, startsAt, endsAt, createdBy: actorRef(input.actor) })
      .returning();
    if (row === undefined) throw new Error('user_restrictions insert returned no row');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'user.restriction.added',
      subject: row.id,
      before: null,
      after: row,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return row;
  });
}

export type LiftRestrictionInput = {
  tenantId: Id<'tnt'>;
  restrictionId: string;
  actor: Actor;
  requestId?: string;
};

/**
 * End a restriction early. Never by a user: a self-exclusion or cool-off is irreversible by
 * the user for its duration (spec 4.6), and the other kinds were not theirs to place.
 */
export async function liftRestriction(db: DbOrTx, input: LiftRestrictionInput): Promise<UserRestriction> {
  if (!isId(input.restrictionId, 'rst')) throw new UsersError('invalid_input', 'restrictionId must be a rst_ id', { field: 'restrictionId' });
  if (input.actor.kind === 'user') {
    throw new UsersError('restriction_lift_forbidden', 'A user cannot lift a restriction; it stands for its duration', { restrictionId: input.restrictionId });
  }
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(userRestrictions).where(eq(userRestrictions.id, input.restrictionId)).for('update');
    if (before === undefined) throw new UsersError('restriction_not_found', `No restriction ${input.restrictionId}`, { restrictionId: input.restrictionId });
    await getUser(tx, input.tenantId, before.userId);
    if (before.liftedAt !== null) {
      throw new UsersError('restriction_already_lifted', `Restriction ${before.id} was lifted at ${before.liftedAt.toISOString()}`, { restrictionId: before.id, liftedAt: before.liftedAt.toISOString() });
    }
    const [after] = await tx
      .update(userRestrictions)
      .set({ liftedAt: sql`now()`, liftedBy: actorRef(input.actor), updatedAt: sql`now()` })
      .where(eq(userRestrictions.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`user_restrictions update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'user.restriction.lifted',
      subject: before.id,
      before,
      after,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}

/** Every restriction ever placed on a user, oldest first. */
export async function listRestrictions(db: DbOrTx, userId: string): Promise<UserRestriction[]> {
  return db.select().from(userRestrictions).where(eq(userRestrictions.userId, userId)).orderBy(asc(userRestrictions.startsAt), asc(userRestrictions.id));
}

/** Restrictions in force at `now`: started, not ended, not lifted. */
export async function activeRestrictions(db: DbOrTx, userId: string, now: Date = new Date()): Promise<UserRestriction[]> {
  const bound = now.toISOString();
  return db
    .select()
    .from(userRestrictions)
    .where(
      and(
        eq(userRestrictions.userId, userId),
        isNull(userRestrictions.liftedAt),
        sql`${userRestrictions.startsAt} <= ${bound}::timestamptz`,
        sql`(${userRestrictions.endsAt} is null or ${userRestrictions.endsAt} > ${bound}::timestamptz)`,
      ),
    )
    .orderBy(asc(userRestrictions.startsAt), asc(userRestrictions.id));
}
