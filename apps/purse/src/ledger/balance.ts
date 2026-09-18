import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../db/client';
import { LedgerError } from './errors';

/**
 * Spec 4.2.3. A balance is derived, never stored: the signed sum of an account's lines
 * relative to its normal side. Bounding on `posted_at` gives a point-in-time balance for
 * free, because nothing in the journal is ever changed after it is posted.
 */
export type BalanceRow = { id: string; balance: string };

/**
 * The balance of one account, optionally as it stood at `asOf` (inclusive). Throws
 * `account_not_found` rather than answering zero for an id that does not exist.
 */
export async function balanceOf(db: DbOrTx, accountId: string, asOf?: Date): Promise<bigint> {
  // Bound as an ISO string: the driver binds a typed parameter as text, not as a Date.
  const bound = asOf?.toISOString() ?? null;
  const rows = await db.execute<BalanceRow>(sql`
    select a.id, coalesce((
      select sum(case when l.direction = a.normal_side then l.amount else -l.amount end)
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where l.account_id = a.id
        and (${bound}::timestamptz is null or e.posted_at <= ${bound}::timestamptz)
    ), 0)::text as balance
    from accounts a
    where a.id = ${accountId}
  `);
  const row = rows[0];
  if (row === undefined) throw new LedgerError('account_not_found', `No account ${accountId}`, { accountId });
  return BigInt(row.balance);
}

/**
 * Current balances for several accounts in one query, keyed by id. Accounts with no lines
 * are present with `0n`; ids that do not exist are simply absent. `postEntry` calls this
 * after taking the row locks, so the sums it sees include every committed line.
 */
export async function balancesOf(db: DbOrTx, accountIds: readonly string[]): Promise<Map<string, bigint>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db.execute<BalanceRow>(sql`
    select a.id,
      coalesce(sum(case when l.direction = a.normal_side then l.amount else -l.amount end), 0)::text as balance
    from accounts a
    left join journal_lines l on l.account_id = a.id
    where a.id in (${sql.join(
      accountIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    group by a.id
  `);
  return new Map(rows.map((row) => [row.id, BigInt(row.balance)]));
}
