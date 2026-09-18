import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { operatorSessions, operators, type Operator, type OperatorSession } from '../db/schema';
import { recordAudit } from '../ledger/audit';
import { OperatorError } from './errors';
import { findOperatorByEmail, hashPassword, operatorActor, verifyPassword } from './operators';

/**
 * Console sessions (spec 4.10). A sign-in mints a 256-bit random token, `cst_` and 43
 * base64url characters, and stores its SHA-256 with an expiry; the console app keeps the
 * token in an HttpOnly cookie on its own origin and presents it to the API as a bearer.
 * Sessions are stateful so a sign-out, a password change or an operator being disabled
 * ends them at once. `last_seen_at` is written at most once a minute per session.
 */
export const SESSION_TOKEN_PREFIX = 'cst_';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const TOKEN_SHAPE = /^cst_[A-Za-z0-9_-]{43}$/;

/** A hash to verify against when the email is unknown, so a miss costs the same as a wrong password. */
const DECOY_HASH_PROMISE = hashPassword('purse-console-decoy-password-never-valid');

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export type SignInInput = { email: string; password: string; now?: Date; requestId?: string };

export type SignedIn = { operator: Operator; session: OperatorSession; token: string };

/**
 * Verify the password and open a session. Every refusal is `invalid_credentials`, and an
 * unknown email still runs one argon2 verification so timing does not tell the two apart.
 */
export async function signIn(db: DbOrTx, input: SignInInput): Promise<SignedIn> {
  const now = input.now ?? new Date();
  const operator = await findOperatorByEmail(db, input.email);
  const decoy = await DECOY_HASH_PROMISE;
  const verified = await verifyPassword(operator ?? { passwordHash: decoy }, input.password);
  if (operator === undefined || !verified) throw new OperatorError('invalid_credentials', 'Email or password is wrong');
  if (operator.disabledAt !== null) throw new OperatorError('operator_disabled', 'This operator account is disabled', { operatorId: operator.id });

  const token = mintSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(operatorSessions)
      .values({ id: newId('ops'), operatorId: operator.id, tokenHash: hashSessionToken(token), expiresAt, lastSeenAt: now, createdAt: now })
      .returning();
    if (session === undefined) throw new Error('operator_sessions insert returned no row');
    await recordAudit(tx, {
      tenantId: null,
      actor: operatorActor(operator),
      action: 'operator.signed_in',
      subject: session.id,
      before: null,
      after: { operatorId: operator.id, expiresAt: expiresAt.toISOString() },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { operator, session, token };
  });
}

export type AuthenticatedOperator = { operator: Operator; session: OperatorSession };

/**
 * Resolve a bearer token to its operator, or throw. Expired, revoked and unknown tokens are
 * distinct codes (the console shows "signed out" copy for the first two) but all
 * `authentication_error`; a disabled operator is refused even with a live session.
 */
export async function authenticateSession(db: DbOrTx, token: string | undefined, now: Date = new Date()): Promise<AuthenticatedOperator> {
  if (token === undefined) throw new OperatorError('missing_session', 'A console session is required');
  if (!TOKEN_SHAPE.test(token)) throw new OperatorError('session_invalid', 'Invalid console session');
  const [found] = await db
    .select({ session: operatorSessions, operator: operators })
    .from(operatorSessions)
    .innerJoin(operators, eq(operators.id, operatorSessions.operatorId))
    .where(eq(operatorSessions.tokenHash, hashSessionToken(token)));
  if (found === undefined) throw new OperatorError('session_invalid', 'Invalid console session');
  if (found.session.revokedAt !== null) throw new OperatorError('session_revoked', 'This console session was signed out', { sessionId: found.session.id });
  if (found.session.expiresAt.getTime() <= now.getTime()) throw new OperatorError('session_expired', 'This console session has expired', { sessionId: found.session.id });
  if (found.operator.disabledAt !== null) throw new OperatorError('operator_disabled', 'This operator account is disabled', { operatorId: found.operator.id });
  if (now.getTime() - found.session.lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
    await db.update(operatorSessions).set({ lastSeenAt: now }).where(eq(operatorSessions.id, found.session.id));
  }
  return found;
}

export type RevokeSessionInput = { sessionId: string; operator: Operator; requestId?: string };

/** Sign out: a revoked session never verifies again. Revoking twice is a no-op. */
export async function revokeSession(db: DbOrTx, input: RevokeSessionInput): Promise<OperatorSession> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(operatorSessions).where(eq(operatorSessions.id, input.sessionId)).for('update');
    if (before === undefined) throw new OperatorError('session_invalid', 'Invalid console session');
    if (before.revokedAt !== null) return before;
    const [after] = await tx.update(operatorSessions).set({ revokedAt: sql`now()` }).where(eq(operatorSessions.id, before.id)).returning();
    if (after === undefined) throw new Error(`operator_sessions update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: null,
      actor: operatorActor(input.operator),
      action: 'operator.signed_out',
      subject: before.id,
      before: { operatorId: before.operatorId, revokedAt: null },
      after: { operatorId: after.operatorId, revokedAt: after.revokedAt?.toISOString() ?? null },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}

/** End every live session of an operator but one (after a password change, the session that changed it stays). Returns how many were revoked. */
export async function revokeOtherSessions(db: DbOrTx, operatorId: string, keepSessionId: string | null): Promise<number> {
  const rows = await db
    .update(operatorSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(operatorSessions.operatorId, operatorId), isNull(operatorSessions.revokedAt), keepSessionId === null ? sql`true` : sql`${operatorSessions.id} <> ${keepSessionId}`))
    .returning({ id: operatorSessions.id });
  return rows.length;
}
