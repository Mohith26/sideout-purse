import { sql } from 'drizzle-orm';
import type { LedgerReplayResource, ReplayAccountResource } from '@purse/types';

import type { DbOrTx } from '../db/client';
import { LedgerError } from './errors';

export const REPLAY_ACCOUNT_LIMIT = 200;

type ReplayAccount = Omit<ReplayAccountResource, 'balance' | 'delta'> & { balance: bigint; delta: bigint };
export type LedgerReplay = Omit<LedgerReplayResource, 'accounts' | 'escrows' | 'lines' | 'totals' | 'entryTotals'> & {
  accounts: ReplayAccount[];
  escrows: ReplayAccount[];
  lines: Array<Omit<LedgerReplayResource['lines'][number], 'amount'> & { amount: bigint }>;
  totals: Array<{ asset: LedgerReplayResource['totals'][number]['asset']; net: bigint }>;
  entryTotals: Array<{ asset: LedgerReplayResource['entryTotals'][number]['asset']; debits: bigint; credits: bigint }>;
};

/**
 * One statement / MVCC snapshot for the cursor, balances and checks. The journal's
 * existing total order is (posted_at, id), including timestamp ties at full DB precision.
 * Aggregate the bounded history once, never run a balance query for each account.
 * Only the account display is paginated; conservation and changed IDs cover all accounts.
 * Metadata describes today's accounts; a not-yet-used account has zero historical balance.
 */
export async function replayLedger(db: DbOrTx, tenantId: string, options: { at?: string; position?: number; after?: string } = {}): Promise<LedgerReplay> {
  const [row] = await db.execute<{ replay: LedgerReplayResource }>(sql`
    with ordered as materialized (
      select e.*, row_number() over (order by e.posted_at, e.id) as position,
        count(*) over () as total
      from journal_entries e where e.tenant_id = ${tenantId}
    ), selected as (
      select * from ordered
      where ${options.at !== undefined ? sql`id = ${options.at}` : options.position !== undefined ? sql`position = ${options.position}` : sql`position = total`}
    ), history as materialized (
      select l.*, a.normal_side,
        case when l.direction = a.normal_side then l.amount else -l.amount end as delta
      from selected s
      join ordered e on e.position <= s.position
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id and a.tenant_id = ${tenantId}
    ), sums as (
      select h.account_id, sum(h.delta)::text as balance,
        coalesce(sum(h.delta) filter (where h.entry_id = s.id), 0)::text as delta,
        count(*)::integer as line_count
      from history h cross join selected s group by h.account_id
    ), balances as materialized (
      select a.id, a.kind, a.asset, a.normal_side as "normalSide", a.owner_ref as "ownerRef",
        coalesce(u.display_name, u.external_id, c.title, a.kind::text) as label,
        coalesce(s.balance, '0') as balance, coalesce(s.delta, '0') as delta,
        coalesce(s.line_count, 0) as "lineCount"
      from accounts a left join sums s on s.account_id = a.id
      left join users u on a.kind = 'user_wallet' and u.id = a.owner_ref
      left join contests c on a.kind = 'contest_escrow' and c.id = a.owner_ref
      where a.tenant_id = ${tenantId}
    ), account_page as (
      select * from balances where ${options.after === undefined ? sql`true` : sql`id > ${options.after}`}
      order by id limit ${REPLAY_ACCOUNT_LIMIT}
    ), totals as (
      select asset, sum(case when "normalSide" = 'credit' then balance::numeric else -balance::numeric end)::text as net
      from balances group by asset
    ), entry_totals as (
      select h.asset,
        coalesce(sum(h.amount) filter (where h.direction = 'debit'), 0)::text as debits,
        coalesce(sum(h.amount) filter (where h.direction = 'credit'), 0)::text as credits
      from history h cross join selected s where h.entry_id = s.id group by h.asset
    )
    select jsonb_build_object(
      'position', coalesce((select position from selected), 0),
      'total', coalesce((select max(total) from ordered), 0),
      'entry', (select jsonb_build_object('id', id, 'tenantId', tenant_id, 'kind', kind,
        'description', description, 'idempotencyKey', idempotency_key, 'contestId', contest_id,
        'reversesEntryId', reverses_entry_id, 'postedAt', posted_at, 'createdAt', created_at) from selected),
      'accounts', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from account_page p), '[]'::jsonb),
      'accountCount', (select count(*) from balances), 'accountLimit', ${REPLAY_ACCOUNT_LIMIT}::integer,
      'nextAccountCursor', (select max(id) from account_page having exists
        (select 1 from balances where id > (select max(id) from account_page))),
      'changedAccountIds', coalesce((select jsonb_agg(id order by id) from balances where delta::numeric <> 0), '[]'::jsonb),
      'escrows', coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from balances b
        where kind = 'contest_escrow' and "lineCount" > 0), '[]'::jsonb),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'sequence', h.sequence,
        'accountId', h.account_id, 'direction', h.direction, 'amount', h.amount::text, 'asset', h.asset)
        order by h.sequence) from history h cross join selected s where h.entry_id = s.id), '[]'::jsonb),
      'totals', coalesce((select jsonb_agg(to_jsonb(t) order by t.asset) from totals t), '[]'::jsonb),
      'entryTotals', coalesce((select jsonb_agg(to_jsonb(t) order by t.asset) from entry_totals t), '[]'::jsonb)
    ) as replay
  `);
  if (row === undefined) throw new Error('Replay query returned no snapshot');
  const value = row.replay;
  if (value.entry === null && (options.at !== undefined || options.position !== undefined)) {
    throw new LedgerError('entry_not_found', 'No journal entry at this replay position in this tenant');
  }
  const account = (a: ReplayAccountResource): ReplayAccount => ({ ...a, balance: BigInt(a.balance), delta: BigInt(a.delta) });
  return {
    ...value,
    accounts: value.accounts.map(account), escrows: value.escrows.map(account),
    lines: value.lines.map((line) => ({ ...line, amount: BigInt(line.amount) })),
    totals: value.totals.map((t) => ({ ...t, net: BigInt(t.net) })),
    entryTotals: value.entryTotals.map((t) => ({ ...t, debits: BigInt(t.debits), credits: BigInt(t.credits) })),
  };
}
