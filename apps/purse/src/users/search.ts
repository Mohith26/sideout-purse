import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { userVerification, users, type User, type VerificationState } from '../db/schema';

/**
 * The console's user lookup (spec 4.10 review queues and restrictions): a tenant's users
 * newest first, or those matching a query against the id, the partner's external id, the
 * display name or the phone. Never a document, never a hash; the profile route has the rest.
 */
export type FoundUser = { user: User; verificationState: VerificationState };

export const USER_LIST_LIMIT_MAX = 200;

export async function searchUsers(db: DbOrTx, input: { tenantId: Id<'tnt'>; query?: string; limit?: number }): Promise<FoundUser[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), USER_LIST_LIMIT_MAX);
  const conditions: SQL[] = [eq(users.tenantId, input.tenantId)];
  const query = input.query?.trim() ?? '';
  if (query !== '') {
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const match = or(eq(users.id, query), eq(users.phoneE164, query), sql`${users.externalId} ilike ${pattern}`, sql`${users.displayName} ilike ${pattern}`);
    if (match !== undefined) conditions.push(match);
  }
  const rows = await db
    .select({ user: users, verificationState: userVerification.state })
    .from(users)
    .innerJoin(userVerification, eq(userVerification.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit);
  return rows.map((row) => ({ user: row.user, verificationState: row.verificationState }));
}
