import { createHash } from 'node:crypto';

import { and, eq, ne, sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { identityFingerprints, operatorFlags, type OperatorFlag, type User } from '../db/schema';

/**
 * Duplicate-identity detection (spec 4.6): hash `(normalized_name, date_of_birth)` and
 * flag collisions across users of a tenant for operator review, never auto-blocking.
 *
 * A fingerprint needs both parts. A user missing either gets a fingerprint of their own id,
 * which collides with nothing, rather than no row, so a name or date of birth that is later
 * cleared cannot leave a stale, still-matching fingerprint behind.
 */

/** Lower-case, diacritics stripped, everything but letters and digits removed: "José  ÁLVAREZ" and "jose alvarez" fingerprint alike. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function identityFingerprint(displayName: string, dateOfBirth: string): string {
  return createHash('sha256').update(`${normalizeName(displayName)}|${dateOfBirth}`).digest('hex');
}

function voidFingerprint(userId: string): string {
  return createHash('sha256').update(`void|${userId}`).digest('hex');
}

export type FingerprintResult = { fingerprint: string; collisions: string[]; flags: OperatorFlag[] };

/**
 * Store the user's current fingerprint and flag every other user of the tenant that shares
 * it. One flag per pair (`pair:<a>:<b>`, ids sorted), so a rerun on either user raises
 * nothing new; a dismissed flag is not raised again either, which is what the operator
 * asked for by dismissing it. Two users written at once with the same fingerprint
 * serialise on an advisory lock over the fingerprint (taken after the caller's user lock,
 * never before it), so the second sees the first's committed row and the pair is flagged.
 */
export async function refreshFingerprint(tx: DbOrTx, user: User): Promise<FingerprintResult> {
  const complete = user.displayName !== null && user.displayName.trim() !== '' && user.dateOfBirth !== null;
  const fingerprint = complete ? identityFingerprint(user.displayName ?? '', user.dateOfBirth ?? '') : voidFingerprint(user.id);

  await tx
    .insert(identityFingerprints)
    .values({ userId: user.id, tenantId: user.tenantId, fingerprint })
    .onConflictDoUpdate({ target: identityFingerprints.userId, set: { fingerprint, computedAt: sql`now()` } });

  if (!complete) return { fingerprint, collisions: [], flags: [] };

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fingerprint:${user.tenantId}:${fingerprint}`}, 0))`);
  const others = await tx
    .select({ userId: identityFingerprints.userId })
    .from(identityFingerprints)
    .where(and(eq(identityFingerprints.tenantId, user.tenantId), eq(identityFingerprints.fingerprint, fingerprint), ne(identityFingerprints.userId, user.id)));
  const collisions = others.map((row) => row.userId).sort();

  const flags: OperatorFlag[] = [];
  for (const other of collisions) {
    const [a, b] = [user.id, other].sort() as [string, string];
    const [flag] = await tx
      .insert(operatorFlags)
      .values({
        id: newId('flg'),
        tenantId: user.tenantId as Id<'tnt'>,
        kind: 'duplicate_identity',
        subject: a,
        dedupeKey: `pair:${a}:${b}`,
        detail: { users: [a, b], fingerprint, raisedBy: user.id },
      })
      .onConflictDoNothing({ target: [operatorFlags.tenantId, operatorFlags.kind, operatorFlags.dedupeKey] })
      .returning();
    if (flag !== undefined) flags.push(flag);
  }
  return { fingerprint, collisions, flags };
}
