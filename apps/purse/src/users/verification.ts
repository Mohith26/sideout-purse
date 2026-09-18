import { eq, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import { issueEmbedToken, type IssuedEmbedToken } from '../auth/embed-tokens';
import type { DbOrTx } from '../db/client';
import { userVerification, type User, type UserVerification } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import type { IdentityProvider, VerificationResult } from '../providers/types';
import { UsersError } from './errors';
import { getUser } from './users';

/**
 * The verification state machine (spec 4.1): `unstarted -> pending -> verified | rejected`,
 * with `verified -> pending` once `reverify_after` has passed. `startVerification` is
 * `POST /users/:id/verification`: it moves the user to `pending`, mints the embed token the
 * iframe identity flow consumes (spec 4.8), calls the `IdentityProvider` seam, and records
 * the outcome with the provider's opaque reference and the instant, never a document.
 *
 * `rejected` is terminal for the user (spec 5.3 shows it as a plain terminal explanation
 * with a support path and no retry button); only an operator reset (phase 5) reopens it.
 * `pending` may be started again: a user who abandoned the iframe gets a fresh token, and
 * a provider that has already decided returns the same decision.
 *
 * The provider is called between two short transactions rather than under the row lock:
 * a real provider is a network call, and what it says is applied only if the user is still
 * `pending` when the answer arrives.
 */
export const REVERIFY_AFTER_DAYS = 365;

export type StartVerificationInput = {
  tenantId: Id<'tnt'>;
  userId: string;
  identity: IdentityProvider;
  actor?: Actor;
  requestId?: string;
  now?: Date;
};

export type StartedVerification = {
  user: User;
  before: UserVerification;
  verification: UserVerification;
  embedToken: IssuedEmbedToken;
  result: VerificationResult;
};

export async function startVerification(db: DbOrTx, input: StartVerificationInput): Promise<StartedVerification> {
  const now = input.now ?? new Date();
  const actor = input.actor ?? SYSTEM_ACTOR;
  const audit = input.requestId === undefined ? {} : { requestId: input.requestId };

  const started = await db.transaction(async (tx) => {
    const user = await getUser(tx, input.tenantId, input.userId);
    const before = await lockVerification(tx, user.id);
    if (before.state === 'rejected') {
      throw new UsersError('verification_rejected', `Identity verification of ${user.id} was rejected; only an operator can reopen it`, { userId: user.id });
    }
    if (before.state === 'verified' && (before.reverifyAfter === null || before.reverifyAfter.getTime() > now.getTime())) {
      throw new UsersError('already_verified', `User ${user.id} is verified${before.reverifyAfter === null ? '' : ` until ${before.reverifyAfter.toISOString()}`}`, {
        userId: user.id,
        verifiedAt: before.verifiedAt?.toISOString() ?? null,
        reverifyAfter: before.reverifyAfter?.toISOString() ?? null,
      });
    }
    let pending = before;
    if (before.state !== 'pending') {
      const [moved] = await tx
        .update(userVerification)
        .set({ state: 'pending', provider: input.identity.name, providerRef: null, verifiedAt: null, reverifyAfter: null, updatedAt: sql`now()` })
        .where(eq(userVerification.userId, user.id))
        .returning();
      if (moved === undefined) throw new Error(`user_verification update of ${user.id} returned no row`);
      pending = moved;
      await recordAudit(tx, {
        tenantId: input.tenantId,
        actor,
        action: before.state === 'verified' ? 'user.verification.restarted' : 'user.verification.started',
        subject: user.id,
        before,
        after: pending,
        ...audit,
      });
    }
    const embedToken = await issueEmbedToken(tx, { tenantId: input.tenantId, userId: user.id, flow: 'identity', now });
    return { user, before, pending, embedToken };
  });

  let result: VerificationResult;
  try {
    result = await input.identity.verify({
      userId: started.user.id,
      tenantId: started.user.tenantId,
      externalId: started.user.externalId,
      displayName: started.user.displayName,
      dateOfBirth: started.user.dateOfBirth,
      phoneE164: started.user.phoneE164,
    });
  } catch (error) {
    // The vendor's error goes to the log as the cause, never to the client.
    throw new UsersError('provider_unavailable', `The identity provider ${input.identity.name} could not complete the check`, { provider: input.identity.name }, { cause: error });
  }

  const verification = await db.transaction(async (tx) => {
    const current = await lockVerification(tx, started.user.id);
    if (current.state !== 'pending') return current;
    const patch =
      result.outcome === 'verified'
        ? { state: 'verified' as const, providerRef: result.providerRef, verifiedAt: now, reverifyAfter: result.reverifyAfter ?? new Date(now.getTime() + REVERIFY_AFTER_DAYS * 86_400_000) }
        : result.outcome === 'rejected'
          ? { state: 'rejected' as const, providerRef: result.providerRef, verifiedAt: null, reverifyAfter: null }
          : { state: 'pending' as const, providerRef: result.providerRef };
    const [after] = await tx
      .update(userVerification)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(userVerification.userId, started.user.id))
      .returning();
    if (after === undefined) throw new Error(`user_verification update of ${started.user.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: { kind: 'system', ref: `provider:${input.identity.name}` },
      action: `user.verification.${result.outcome}`,
      subject: started.user.id,
      before: current,
      after: { ...after, ...(result.note === undefined ? {} : { note: result.note }) },
      ...audit,
    });
    return after;
  });

  return { user: started.user, before: started.before, verification, embedToken: started.embedToken, result };
}

async function lockVerification(tx: DbOrTx, userId: string): Promise<UserVerification> {
  const [row] = await tx.select().from(userVerification).where(eq(userVerification.userId, userId)).for('update');
  if (row === undefined) throw new Error(`user_verification row for ${userId} is missing`);
  return row;
}
