import { and, isNotNull, lt, or } from 'drizzle-orm';

import type { DbOrTx } from '../db/client';
import { embedSigninCodes, embedTokens, IDEMPOTENCY_TTL_DAYS, idempotencyKeys, idempotencyReservations, operatorSessions } from '../db/schema';

/**
 * Retention (spec 4.1: idempotency keys, TTL 30 days). A key is remembered for at least
 * the TTL; this removes it afterwards, and with it the guarantee that a replay of that key
 * is answered from the stored response rather than performed again, which is the
 * documented contract. The claim that guarded a key while its request ran goes with it.
 * Embed tokens are five-minute artefacts and are kept a day past their use or expiry for
 * the audit trail a support question needs; sign-in codes (ten minutes) the same, and
 * console sessions a month past their expiry or sign-out (the audit log keeps the sign-in
 * itself). Webhook deliveries and attempts are kept: they are the delivery log. Runs as the
 * owner: the runtime role cannot delete from any of these tables.
 */
export const EMBED_TOKEN_RETENTION_MS = 24 * 3_600_000;
export const OPERATOR_SESSION_RETENTION_MS = 30 * 86_400_000;

export type PurgeResult = { idempotencyKeys: number; idempotencyReservations: number; embedTokens: number; signinCodes: number; operatorSessions: number; before: string };

export async function purgeExpired(db: DbOrTx, now: Date = new Date()): Promise<PurgeResult> {
  const keysBefore = new Date(now.getTime() - IDEMPOTENCY_TTL_DAYS * 86_400_000);
  const tokensBefore = new Date(now.getTime() - EMBED_TOKEN_RETENTION_MS);
  const keys = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, keysBefore)).returning({ key: idempotencyKeys.key });
  const reservations = await db.delete(idempotencyReservations).where(lt(idempotencyReservations.reservedAt, keysBefore)).returning({ key: idempotencyReservations.key });
  const tokens = await db
    .delete(embedTokens)
    .where(or(and(isNotNull(embedTokens.consumedAt), lt(embedTokens.consumedAt, tokensBefore)), lt(embedTokens.expiresAt, tokensBefore)))
    .returning({ id: embedTokens.id });
  const codes = await db.delete(embedSigninCodes).where(lt(embedSigninCodes.expiresAt, tokensBefore)).returning({ id: embedSigninCodes.id });
  const sessionsBefore = new Date(now.getTime() - OPERATOR_SESSION_RETENTION_MS);
  const sessions = await db
    .delete(operatorSessions)
    .where(or(lt(operatorSessions.expiresAt, sessionsBefore), and(isNotNull(operatorSessions.revokedAt), lt(operatorSessions.revokedAt, sessionsBefore))))
    .returning({ id: operatorSessions.id });
  return {
    idempotencyKeys: keys.length,
    idempotencyReservations: reservations.length,
    embedTokens: tokens.length,
    signinCodes: codes.length,
    operatorSessions: sessions.length,
    before: keysBefore.toISOString(),
  };
}
