import { sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { Account, AccountKind, AccountStatus, Asset, ContestState, JournalEntry, JournalEntryKind, JournalLine, LedgerSide } from '../db/schema';
import { balanceOf } from './balance';
import { LedgerError } from './errors';
import { getEntry, linesOf, reversalOf } from './post';
import { signedDelta } from './validate';

/**
 * The ledger explorer's reads (spec 4.10): the account tree of a tenant with derived
 * balances, one account with its balance now and at a point in time, the entries that
 * touched it with a running balance, one entry with every line and the per-asset sums
 * that prove it balances, and the journal itself, newest first. Everything is derived
 * from the journal in SQL, cast `::text` and parsed as `bigint`; nothing is stored or
 * cached, so the panel that shows it is always the truth as of the query.
 */
export type AccountOwner =
  | { kind: 'user'; id: string; externalId: string; displayName: string | null }
  | { kind: 'contest'; id: string; title: string; state: ContestState }
  | null;

export type AccountSummary = {
  id: string;
  tenantId: string;
  kind: AccountKind;
  asset: Asset;
  normalSide: LedgerSide;
  status: AccountStatus;
  ownerRef: string | null;
  owner: AccountOwner;
  balance: bigint;
  lineCount: number;
  createdAt: Date;
};

type AccountRow = {
  id: string;
  tenant_id: string;
  kind: AccountKind;
  asset: Asset;
  normal_side: LedgerSide;
  status: AccountStatus;
  owner_ref: string | null;
  created_at: string;
  balance: string;
  line_count: string;
  user_external_id: string | null;
  user_display_name: string | null;
  contest_title: string | null;
  contest_state: ContestState | null;
};

const ACCOUNT_SELECT = sql`
  select a.id, a.tenant_id, a.kind, a.asset, a.normal_side, a.status, a.owner_ref, a.created_at,
    coalesce((
      select sum(case when l.direction = a.normal_side then l.amount else -l.amount end)
      from journal_lines l where l.account_id = a.id
    ), 0)::text as balance,
    (select count(*) from journal_lines l where l.account_id = a.id)::text as line_count,
    u.external_id as user_external_id, u.display_name as user_display_name,
    c.title as contest_title, c.state as contest_state
  from accounts a
  left join users u on a.kind = 'user_wallet' and u.id = a.owner_ref
  left join contests c on a.kind = 'contest_escrow' and c.id = a.owner_ref
`;

function toSummary(row: AccountRow): AccountSummary {
  let owner: AccountOwner = null;
  if (row.kind === 'user_wallet' && row.owner_ref !== null) {
    owner = { kind: 'user', id: row.owner_ref, externalId: row.user_external_id ?? '', displayName: row.user_display_name };
  } else if (row.kind === 'contest_escrow' && row.owner_ref !== null) {
    owner = { kind: 'contest', id: row.owner_ref, title: row.contest_title ?? '', state: row.contest_state ?? 'draft' };
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    asset: row.asset,
    normalSide: row.normal_side,
    status: row.status,
    ownerRef: row.owner_ref,
    owner,
    balance: BigInt(row.balance),
    lineCount: Number(row.line_count),
    createdAt: new Date(row.created_at),
  };
}

/** Every account of a tenant with its derived balance, ordered by kind (the spec 4.2.1 table order), asset and owner. */
export async function accountTree(db: DbOrTx, tenantId: Id<'tnt'>): Promise<AccountSummary[]> {
  const rows = await db.execute<AccountRow>(sql`${ACCOUNT_SELECT} where a.tenant_id = ${tenantId} order by a.kind, a.asset, a.owner_ref nulls first, a.id`);
  return rows.map(toSummary);
}

export async function accountSummary(db: DbOrTx, accountId: string): Promise<AccountSummary> {
  const rows = await db.execute<AccountRow>(sql`${ACCOUNT_SELECT} where a.id = ${accountId}`);
  const row = rows[0];
  if (row === undefined) throw new LedgerError('account_not_found', `No account ${accountId}`, { accountId });
  return toSummary(row);
}

export type AccountDetail = AccountSummary & {
  /** The balance as it stood at `asOf` (inclusive), when one was asked for. */
  asOf: { at: Date; balance: bigint } | null;
  firstPostedAt: Date | null;
  lastPostedAt: Date | null;
};

export async function accountDetail(db: DbOrTx, accountId: string, asOf?: Date): Promise<AccountDetail> {
  const summary = await accountSummary(db, accountId);
  const [span] = await db.execute<{ first: string | null; last: string | null }>(sql`
    select min(e.posted_at)::text as first, max(e.posted_at)::text as last
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_id = ${accountId}
  `);
  return {
    ...summary,
    asOf: asOf === undefined ? null : { at: asOf, balance: await balanceOf(db, accountId, asOf) },
    firstPostedAt: span?.first === null || span?.first === undefined ? null : new Date(span.first),
    lastPostedAt: span?.last === null || span?.last === undefined ? null : new Date(span.last),
  };
}

/** A keyset cursor over `(posted_at desc, id desc)`: the epoch milliseconds and the id of the last row seen. */
export type EntryCursor = { postedAt: Date; id: string };

export const ENTRY_LIST_LIMIT_MAX = 200;

export function encodeCursor(cursor: EntryCursor): string {
  return `${cursor.postedAt.getTime()}:${cursor.id}`;
}

export function decodeCursor(value: string): EntryCursor {
  const match = /^(\d{1,15}):(je_[0-9a-f-]{36})$/.exec(value);
  if (match === null) throw new LedgerError('invalid_input', 'cursor is not a journal cursor', { field: 'cursor' });
  return { postedAt: new Date(Number(match[1])), id: match[2] ?? '' };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), ENTRY_LIST_LIMIT_MAX);
}

export type AccountEntry = {
  entry: JournalEntry;
  /** This account's line in the entry. */
  line: JournalLine;
  /** The line's effect on the account, relative to its normal side. */
  delta: bigint;
  /** The account's balance once this line had posted. */
  balanceAfter: bigint;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * The entries that touched an account, newest first, each with its running balance. The
 * window sum runs over the whole history in posting order and the page is cut after it,
 * so a page in the middle still shows the right balance at each row.
 */
export async function accountEntries(db: DbOrTx, account: Pick<Account, 'id' | 'normalSide'>, options: { limit?: number; cursor?: EntryCursor } = {}): Promise<Page<AccountEntry>> {
  const limit = clampLimit(options.limit);
  const cursor = options.cursor;
  const rows = await db.execute<{
    e_id: string;
    e_tenant_id: string;
    e_kind: JournalEntryKind;
    e_description: string;
    e_idempotency_key: string;
    e_request_hash: string;
    e_contest_id: string | null;
    e_reverses_entry_id: string | null;
    e_created_at: string;
    e_posted_at: string;
    l_id: string;
    l_entry_id: string;
    l_account_id: string;
    l_direction: LedgerSide;
    l_amount: string;
    l_asset: Asset;
    l_sequence: number;
    balance_after: string;
  }>(sql`
    with history as (
      select e.id as e_id, e.tenant_id as e_tenant_id, e.kind as e_kind, e.description as e_description,
        e.idempotency_key as e_idempotency_key, e.request_hash as e_request_hash, e.contest_id as e_contest_id,
        e.reverses_entry_id as e_reverses_entry_id, e.created_at as e_created_at, e.posted_at as e_posted_at,
        l.id as l_id, l.entry_id as l_entry_id, l.account_id as l_account_id, l.direction as l_direction,
        l.amount::text as l_amount, l.asset as l_asset, l.sequence as l_sequence,
        sum(case when l.direction = ${account.normalSide}::ledger_side then l.amount else -l.amount end)
          over (order by e.posted_at, e.id, l.sequence rows unbounded preceding)::text as balance_after
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where l.account_id = ${account.id}
    )
    select * from history
    where ${cursor === undefined ? sql`true` : sql`(e_posted_at, e_id) < (${cursor.postedAt.toISOString()}::timestamptz, ${cursor.id})`}
    order by e_posted_at desc, e_id desc, l_sequence desc
    limit ${limit + 1}
  `);
  const items: AccountEntry[] = rows.slice(0, limit).map((row) => {
    const entry: JournalEntry = {
      id: row.e_id,
      tenantId: row.e_tenant_id,
      kind: row.e_kind,
      description: row.e_description,
      idempotencyKey: row.e_idempotency_key,
      requestHash: row.e_request_hash,
      contestId: row.e_contest_id,
      reversesEntryId: row.e_reverses_entry_id,
      createdAt: new Date(row.e_created_at),
      postedAt: new Date(row.e_posted_at),
    };
    const line: JournalLine = { id: row.l_id, entryId: row.l_entry_id, accountId: row.l_account_id, direction: row.l_direction, amount: BigInt(row.l_amount), asset: row.l_asset, sequence: row.l_sequence };
    return { entry, line, delta: signedDelta(account.normalSide, line.direction, line.amount), balanceAfter: BigInt(row.balance_after) };
  });
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ postedAt: last.entry.postedAt, id: last.entry.id }) : null };
}

export type EntryLine = {
  line: JournalLine;
  account: AccountSummary;
  /** The line's effect on its account, relative to the account's normal side. */
  delta: bigint;
};

export type AssetTotals = { asset: Asset; debits: bigint; credits: bigint; balanced: boolean };

export type EntryDetail = {
  entry: JournalEntry;
  lines: EntryLine[];
  totals: AssetTotals[];
  /** Whether every asset's debits equal its credits (spec 4.2.2 rules 1 to 3, re-derived here from the rows). */
  balanced: boolean;
  /** The entry this one reverses, if it is a correction. */
  reverses: JournalEntry | null;
  /** The entry that reversed this one, if it has been corrected. */
  reversedBy: JournalEntry | null;
  contest: { id: string; title: string; state: ContestState } | null;
};

export async function entryDetail(db: DbOrTx, entryId: string): Promise<EntryDetail> {
  const entry = await getEntry(db, entryId);
  const lines = await linesOf(db, entry.id);
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accountRows = accountIds.length === 0 ? [] : await db.execute<AccountRow>(sql`${ACCOUNT_SELECT} where a.id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})`);
  const accountsById = new Map(accountRows.map((row) => [row.id, toSummary(row)]));
  const detailed: EntryLine[] = lines.map((line) => {
    const account = accountsById.get(line.accountId);
    if (account === undefined) throw new Error(`journal line ${line.id} names a missing account ${line.accountId}`);
    return { line, account, delta: signedDelta(account.normalSide, line.direction, line.amount) };
  });
  const byAsset = new Map<Asset, { debits: bigint; credits: bigint }>();
  for (const { line } of detailed) {
    const totals = byAsset.get(line.asset) ?? { debits: 0n, credits: 0n };
    if (line.direction === 'debit') totals.debits += line.amount;
    else totals.credits += line.amount;
    byAsset.set(line.asset, totals);
  }
  const totals: AssetTotals[] = [...byAsset].map(([asset, sums]) => ({ asset, ...sums, balanced: sums.debits === sums.credits }));
  const contest =
    entry.contestId === null
      ? null
      : ((await db.execute<{ id: string; title: string; state: ContestState }>(sql`select id, title, state from contests where id = ${entry.contestId}`))[0] ?? null);
  return {
    entry,
    lines: detailed,
    totals,
    balanced: totals.length > 0 && totals.every((each) => each.balanced),
    reverses: entry.reversesEntryId === null ? null : await getEntry(db, entry.reversesEntryId),
    reversedBy: (await reversalOf(db, entry.id)) ?? null,
    contest,
  };
}

export type EntrySummary = {
  entry: JournalEntry;
  lineCount: number;
  asset: Asset | null;
  /** The sum of the entry's debits, which equals its credits: what the entry moved. */
  amount: bigint;
};

export type ListEntriesInput = {
  tenantId: Id<'tnt'>;
  kind?: JournalEntryKind;
  contestId?: string;
  limit?: number;
  cursor?: EntryCursor;
};

/** A tenant's journal, newest first. */
export async function listEntries(db: DbOrTx, input: ListEntriesInput): Promise<Page<EntrySummary>> {
  const limit = clampLimit(input.limit);
  const rows = await db.execute<{
    id: string;
    tenant_id: string;
    kind: JournalEntryKind;
    description: string;
    idempotency_key: string;
    request_hash: string;
    contest_id: string | null;
    reverses_entry_id: string | null;
    created_at: string;
    posted_at: string;
    line_count: string;
    asset: Asset | null;
    amount: string;
  }>(sql`
    select e.*,
      (select count(*) from journal_lines l where l.entry_id = e.id)::text as line_count,
      (select min(l.asset) from journal_lines l where l.entry_id = e.id) as asset,
      coalesce((select sum(l.amount) from journal_lines l where l.entry_id = e.id and l.direction = 'debit'), 0)::text as amount
    from journal_entries e
    where e.tenant_id = ${input.tenantId}
      and ${input.kind === undefined ? sql`true` : sql`e.kind = ${input.kind}::journal_entry_kind`}
      and ${input.contestId === undefined ? sql`true` : sql`e.contest_id = ${input.contestId}`}
      and ${input.cursor === undefined ? sql`true` : sql`(e.posted_at, e.id) < (${input.cursor.postedAt.toISOString()}::timestamptz, ${input.cursor.id})`}
    order by e.posted_at desc, e.id desc
    limit ${limit + 1}
  `);
  const items: EntrySummary[] = rows.slice(0, limit).map((row) => ({
    entry: {
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      description: row.description,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      contestId: row.contest_id,
      reversesEntryId: row.reverses_entry_id,
      createdAt: new Date(row.created_at),
      postedAt: new Date(row.posted_at),
    },
    lineCount: Number(row.line_count),
    asset: row.asset,
    amount: BigInt(row.amount),
  }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ postedAt: last.entry.postedAt, id: last.entry.id }) : null };
}
