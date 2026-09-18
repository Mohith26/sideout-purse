import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { contests, tenants, type Contest, type ContestState } from '../db/schema';

/**
 * The console's contest browser (spec 4.10): contests across every tenant or one, by
 * state, newest first, each with the two derived figures the resource carries (escrow
 * balance from the journal, active participant count) and the tenant's name.
 */
export type BrowsedContest = { contest: Contest; tenantName: string; escrowBalance: bigint; participantCount: number };

export type BrowseContestsInput = { tenantId?: Id<'tnt'>; state?: ContestState; limit?: number };

export const CONTEST_LIST_LIMIT_MAX = 200;

export async function browseContests(db: DbOrTx, input: BrowseContestsInput = {}): Promise<BrowsedContest[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), CONTEST_LIST_LIMIT_MAX);
  const conditions: SQL[] = [];
  if (input.tenantId !== undefined) conditions.push(eq(contests.tenantId, input.tenantId));
  if (input.state !== undefined) conditions.push(eq(contests.state, input.state));
  // Drizzle renders a column inside a subquery unqualified, so the correlated references are spelled out.
  const rows = await db
    .select({
      contest: contests,
      tenantName: tenants.name,
      escrowBalance: sql<string>`coalesce((
        select sum(case when l.direction = 'credit' then l.amount else -l.amount end)
        from journal_lines l where l.account_id = contests.escrow_account_id
      ), 0)::text`,
      participantCount: sql<string>`(select count(*) from contest_participants p where p.contest_id = contests.id and p.state = 'entered')::text`,
    })
    .from(contests)
    .innerJoin(tenants, eq(tenants.id, contests.tenantId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(contests.createdAt), desc(contests.id))
    .limit(limit);
  return rows.map((row) => ({ contest: row.contest, tenantName: row.tenantName, escrowBalance: BigInt(row.escrowBalance), participantCount: Number(row.participantCount) }));
}
