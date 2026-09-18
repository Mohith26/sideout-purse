import { sql } from 'drizzle-orm';
import type { Asset } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';

/**
 * Velocity (spec 4.6): rolling 24-hour and 7-day entry totals, computed from the journal
 * rather than a counter column. What counts is every `escrow` entry's debit of the user's
 * wallet in the asset, gross: a stake that was later refunded still counted as staked at
 * the time (docs/decisions.md, "velocity is gross and per asset"). Bounded on `posted_at`,
 * the ledger's own clock.
 */
export type Velocity = { enteredLast24h: bigint; enteredLast7d: bigint };

export const VELOCITY_WINDOWS = { last24h: 24 * 3_600_000, last7d: 7 * 24 * 3_600_000 } as const;

export async function entryVelocity(db: DbOrTx, input: { tenantId: Id<'tnt'>; userId: string; asset: Asset; now: Date }): Promise<Velocity> {
  const since24h = new Date(input.now.getTime() - VELOCITY_WINDOWS.last24h).toISOString();
  const since7d = new Date(input.now.getTime() - VELOCITY_WINDOWS.last7d).toISOString();
  const rows = await db.execute<{ last24h: string; last7d: string }>(sql`
    select
      coalesce(sum(case when e.posted_at > ${since24h}::timestamptz then l.amount else 0 end), 0)::text as last24h,
      coalesce(sum(l.amount), 0)::text as last7d
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where a.tenant_id = ${input.tenantId}
      and a.kind = 'user_wallet'
      and a.owner_ref = ${input.userId}
      and a.asset = ${input.asset}
      and l.direction = 'debit'
      and e.kind = 'escrow'
      and e.posted_at > ${since7d}::timestamptz
  `);
  const row = rows[0];
  return { enteredLast24h: BigInt(row?.last24h ?? '0'), enteredLast7d: BigInt(row?.last7d ?? '0') };
}
