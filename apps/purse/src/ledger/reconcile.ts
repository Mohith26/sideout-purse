import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../db/client';

/**
 * Spec 4.2.4: the invariants as a `reconcile()` routine. Runs in CI after the seed
 * (`pnpm --filter @purse/api reconcile`), after the randomized operation test, on a
 * schedule in production, and behind `GET /internal/reconcile`. A failing invariant is a
 * hard alarm: the script exits non-zero and the route answers 500.
 *
 * Each invariant is a registry entry that returns `{ ok, detail }`; the report lists all
 * nine every time. I4, I5 and I7 are about contests and settlement and read the phase 2
 * tables; I8 and I9 are about the treasury (spec section 13) and read the payments table;
 * a check that is not yet applicable would be registered with `notApplicableUntil` and
 * reported as such rather than silently passing.
 */
export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9';

export type InvariantResult = {
  id: InvariantId;
  name: string;
  /** False only when a checked invariant is violated. Not-applicable entries are `true`. */
  ok: boolean;
  status: 'ok' | 'failed' | 'not_applicable';
  /** What was checked and what was found, in a sentence an operator can act on. */
  detail: string;
  /** Present only on not-applicable entries: the phase that will implement the check. */
  notApplicableUntil?: string;
};

export type ReconcileReport = {
  ok: boolean;
  ranAt: string;
  durationMs: number;
  invariants: InvariantResult[];
};

type Outcome = { ok: boolean; detail: string };

type InvariantCheck =
  | { id: InvariantId; name: string; check: (db: DbOrTx) => Promise<Outcome> }
  | { id: InvariantId; name: string; notApplicableUntil: string; detail: string };

const LIMIT = 20;

/** Signed line value relative to its account's normal side, the same arithmetic as `signedDelta`. */
const SIGNED = sql`case when l.direction = a.normal_side then l.amount else -l.amount end`;

async function i1(db: DbOrTx): Promise<Outcome> {
  const rows = await db.execute<{ asset: string; debits: string; credits: string }>(sql`
    select asset,
      sum(case when direction = 'debit' then amount else 0 end)::text as debits,
      sum(case when direction = 'credit' then amount else 0 end)::text as credits
    from journal_lines
    group by asset
    order by asset
  `);
  if (rows.length === 0) return { ok: true, detail: 'journal is empty' };
  const broken = rows.filter((row) => row.debits !== row.credits);
  const summary = rows.map((row) => `${row.asset}: debits ${row.debits}, credits ${row.credits}`).join('; ');
  return broken.length === 0
    ? { ok: true, detail: `nets to zero per asset (${summary})` }
    : { ok: false, detail: `journal does not net to zero for ${broken.map((row) => row.asset).join(', ')} (${summary})` };
}

async function i2(db: DbOrTx): Promise<Outcome> {
  const [count] = await db.execute<{ entries: string }>(sql`select count(*)::text as entries from journal_entries`);
  const rows = await db.execute<{ id: string; lines: string; assets: string; net: string }>(sql`
    select e.id, count(l.id)::text as lines, count(distinct l.asset)::text as assets,
      coalesce(sum(case when l.direction = 'debit' then l.amount else -l.amount end), 0)::text as net
    from journal_entries e
    left join journal_lines l on l.entry_id = e.id
    group by e.id
    having count(l.id) < 2
      or count(distinct l.asset) <> 1
      or coalesce(sum(case when l.direction = 'debit' then l.amount else -l.amount end), 0) <> 0
    order by e.id
    limit ${LIMIT}
  `);
  if (rows.length === 0) return { ok: true, detail: `every one of ${count?.entries ?? '0'} entries has 2+ lines in one asset and balances` };
  const described = rows.map((row) => `${row.id} (lines ${row.lines}, assets ${row.assets}, debits-credits ${row.net})`);
  return { ok: false, detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} entries do not balance: ${described.join('; ')}` };
}

async function i3(db: DbOrTx): Promise<Outcome> {
  const [count] = await db.execute<{ wallets: string }>(sql`select count(*)::text as wallets from accounts where kind = 'user_wallet'`);
  const rows = await db.execute<{ id: string; balance: string }>(sql`
    select a.id, coalesce(sum(${SIGNED}), 0)::text as balance
    from accounts a
    left join journal_lines l on l.account_id = a.id
    where a.kind = 'user_wallet'
    group by a.id
    having coalesce(sum(${SIGNED}), 0) < 0
    order by a.id
    limit ${LIMIT}
  `);
  if (rows.length === 0) return { ok: true, detail: `none of ${count?.wallets ?? '0'} user wallets is negative` };
  return {
    ok: false,
    detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} user wallets are negative: ${rows.map((row) => `${row.id}=${row.balance}`).join(', ')}`,
  };
}

/**
 * I6 has two halves: there is no snapshot table (phase 1), or every row in it equals the
 * derived balance as of its entry. Adding `account_balance_snapshots` later needs no change
 * here; the spec's columns are assumed (`account_id`, `as_of_entry_id`, `balance`).
 */
async function i6(db: DbOrTx): Promise<Outcome> {
  const [presence] = await db.execute<{ present: boolean }>(
    sql`select to_regclass('public.account_balance_snapshots') is not null as present`,
  );
  if (presence?.present !== true) return { ok: true, detail: 'no account_balance_snapshots table; balances are derived only' };

  const [count] = await db.execute<{ snapshots: string }>(sql`select count(*)::text as snapshots from account_balance_snapshots`);
  const rows = await db.execute<{ account_id: string; snapshot: string; derived: string }>(sql`
    select s.account_id, s.balance::text as snapshot, derived.balance::text as derived
    from account_balance_snapshots s
    join accounts a on a.id = s.account_id
    join journal_entries as_of on as_of.id = s.as_of_entry_id
    cross join lateral (
      select coalesce(sum(${SIGNED}), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where l.account_id = a.id and e.posted_at <= as_of.posted_at
    ) derived
    where s.balance <> derived.balance
    order by s.account_id
    limit ${LIMIT}
  `);
  if (rows.length === 0) return { ok: true, detail: `all ${count?.snapshots ?? '0'} snapshots equal their derived balance` };
  return {
    ok: false,
    detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} snapshots diverge: ${rows
      .map((row) => `${row.account_id} snapshot ${row.snapshot} vs derived ${row.derived}`)
      .join('; ')}`,
  };
}

/**
 * I4. Spec: every `settled` contest's escrow is exactly zero. `voided` contests are held to
 * the same line (spec 4.3 defines both terminal states with "escrow zero"), so a void that
 * missed a refund is caught here too.
 */
async function i4(db: DbOrTx): Promise<Outcome> {
  const [count] = await db.execute<{ contests: string }>(sql`select count(*)::text as contests from contests where state in ('settled', 'voided')`);
  const rows = await db.execute<{ id: string; state: string; balance: string }>(sql`
    select c.id, c.state::text as state, coalesce(sum(${SIGNED}), 0)::text as balance
    from contests c
    join accounts a on a.id = c.escrow_account_id
    left join journal_lines l on l.account_id = a.id
    where c.state in ('settled', 'voided')
    group by c.id, c.state
    having coalesce(sum(${SIGNED}), 0) <> 0
    order by c.id
    limit ${LIMIT}
  `);
  if (rows.length === 0) return { ok: true, detail: `every one of ${count?.contests ?? '0'} settled or voided contests has an empty escrow` };
  return {
    ok: false,
    detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} settled or voided contests still hold escrow: ${rows.map((row) => `${row.id} (${row.state}) = ${row.balance}`).join('; ')}`,
  };
}

/**
 * I5. For every `settled` contest, the sum of `contest_results.payout_amount` equals what
 * the contest escrowed: every credit into its escrow account less every debit out of it
 * other than the settlement itself (withdrawals refunded before lock, corrections). With
 * I4 holding, that is exactly what the `settle` entry paid out.
 */
async function i5(db: DbOrTx): Promise<Outcome> {
  const [count] = await db.execute<{ contests: string }>(sql`select count(*)::text as contests from contests where state = 'settled'`);
  const rows = await db.execute<{ id: string; paid: string; escrowed: string }>(sql`
    select c.id,
      coalesce((select sum(r.payout_amount) from contest_results r where r.contest_id = c.id), 0)::text as paid,
      coalesce((
        select sum(case when l.direction = 'credit' then l.amount else -l.amount end)
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        where l.account_id = c.escrow_account_id and e.kind <> 'settle'
      ), 0)::text as escrowed
    from contests c
    where c.state = 'settled'
      and coalesce((select sum(r.payout_amount) from contest_results r where r.contest_id = c.id), 0) <> coalesce((
        select sum(case when l.direction = 'credit' then l.amount else -l.amount end)
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        where l.account_id = c.escrow_account_id and e.kind <> 'settle'
      ), 0)
    order by c.id
    limit ${LIMIT}
  `);
  if (rows.length === 0) return { ok: true, detail: `results of every one of ${count?.contests ?? '0'} settled contests sum to what it escrowed` };
  return {
    ok: false,
    detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} settled contests pay out something other than what they escrowed: ${rows
      .map((row) => `${row.id} paid ${row.paid} of ${row.escrowed}`)
      .join('; ')}`,
  };
}

/**
 * I7. Every participant's `entry_journal_entry_id` is an `escrow` entry of the contest's
 * tenant, carrying the contest's id, with exactly two lines: a debit of that user's wallet
 * and a credit of that contest's escrow account, both in the contest's asset for the
 * contest's entry amount.
 */
async function i7(db: DbOrTx): Promise<Outcome> {
  const [count] = await db.execute<{ participants: string }>(sql`select count(*)::text as participants from contest_participants`);
  const rows = await db.execute<{ id: string; contest_id: string; user_id: string; entry_id: string }>(sql`
    select p.id, p.contest_id, p.user_id, p.entry_journal_entry_id as entry_id
    from contest_participants p
    join contests c on c.id = p.contest_id
    where not exists (
      select 1 from journal_entries e
      where e.id = p.entry_journal_entry_id
        and e.kind = 'escrow'
        and e.tenant_id = c.tenant_id
        and e.contest_id = c.id
        and (select count(*) from journal_lines l where l.entry_id = e.id) = 2
        and exists (
          select 1 from journal_lines l
          join accounts a on a.id = l.account_id
          where l.entry_id = e.id and l.direction = 'debit'
            and a.kind = 'user_wallet' and a.tenant_id = c.tenant_id and a.owner_ref = p.user_id
            and l.asset = c.asset and l.amount = c.entry_amount
        )
        and exists (
          select 1 from journal_lines l
          where l.entry_id = e.id and l.direction = 'credit'
            and l.account_id = c.escrow_account_id
            and l.asset = c.asset and l.amount = c.entry_amount
        )
    )
    order by p.id
    limit ${LIMIT}
  `);
  if (rows.length === 0) return { ok: true, detail: `every one of ${count?.participants ?? '0'} participants links to a matching escrow entry` };
  return {
    ok: false,
    detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} participants do not link to a matching escrow entry: ${rows
      .map((row) => `${row.id} (${row.user_id} in ${row.contest_id} -> ${row.entry_id})`)
      .join('; ')}`,
  };
}

/**
 * I8, the custody reconciliation (spec 13.5). The `external_settlement` account's balance
 * must equal every funded deposit less every funded withdrawal, converted at one CREDIT to
 * one US cent.
 *
 * This is the invariant that makes the fiat rail honest. The payments table is what the
 * rail did; the ledger is what users are owed. They are two independent descriptions of the
 * same dollars, written by different code paths, and if they ever disagree then either
 * money was credited without a payment behind it or a payment funded without reaching the
 * ledger. Both are the kind of bug that is invisible until an audit, so it pages instead.
 *
 * A database with no payments table yet passes trivially, the same way I6 treats a missing
 * snapshot table.
 */
async function i8(db: DbOrTx): Promise<Outcome> {
  const [presence] = await db.execute<{ present: boolean }>(sql`select to_regclass('public.payments') is not null as present`);
  if (presence?.present !== true) return { ok: true, detail: 'no payments table; nothing has moved across the rail' };

  const rows = await db.execute<{ tenant_id: string; expected: string; actual: string; deposits: string; withdrawals: string }>(sql`
    with moved as (
      select tenant_id,
        coalesce(sum(case when direction = 'deposit' then amount_usd_cents else 0 end), 0) as deposited,
        coalesce(sum(case when direction = 'withdrawal' then amount_usd_cents else 0 end), 0) as withdrawn,
        count(*) filter (where direction = 'deposit') as deposits,
        count(*) filter (where direction = 'withdrawal') as withdrawals
      from payments
      where funded_at is not null
      group by tenant_id
    ),
    custody as (
      select a.tenant_id, coalesce(sum(${SIGNED}), 0) as balance
      from accounts a
      left join journal_lines l on l.account_id = a.id
      where a.kind = 'external_settlement'
      group by a.tenant_id
    )
    select coalesce(m.tenant_id, c.tenant_id) as tenant_id,
      (coalesce(m.deposited, 0) - coalesce(m.withdrawn, 0))::text as expected,
      coalesce(c.balance, 0)::text as actual,
      coalesce(m.deposits, 0)::text as deposits,
      coalesce(m.withdrawals, 0)::text as withdrawals
    from moved m
    full outer join custody c on c.tenant_id = m.tenant_id
    where (coalesce(m.deposited, 0) - coalesce(m.withdrawn, 0)) <> coalesce(c.balance, 0)
    order by 1
    limit ${LIMIT}
  `);
  const [totals] = await db.execute<{ funded: string }>(sql`select count(*)::text as funded from payments where funded_at is not null`);
  if (rows.length === 0) {
    return { ok: true, detail: `custody matches the ledger for every tenant across ${totals?.funded ?? '0'} funded payments` };
  }
  return {
    ok: false,
    detail: `${rows.length}${rows.length === LIMIT ? '+' : ''} tenants' custody does not match the ledger: ${rows
      .map((row) => `${row.tenant_id} expected ${row.expected} from ${row.deposits} deposits and ${row.withdrawals} withdrawals, ledger holds ${row.actual}`)
      .join('; ')}`,
  };
}

/**
 * I9, the rake reconciliation (spec 13.5). Every `platform_fee` account's balance must
 * equal the sum of the `fee` entries that credited it, and every `fee` entry must name a
 * contest and be exactly two lines: a debit of that contest's escrow and a credit of the
 * platform fee account, in the contest's asset.
 *
 * The second half is what matters. Without it, a `fee` entry could take value out of some
 * other contest's escrow, which I4 and I5 would not catch: they only ever look at a
 * contest's own totals, and a fee sourced from the wrong escrow leaves both of them true.
 */
async function i9(db: DbOrTx): Promise<Outcome> {
  const [count] = await db.execute<{ fees: string }>(sql`select count(*)::text as fees from journal_entries where kind = 'fee'`);
  const malformed = await db.execute<{ id: string; reason: string }>(sql`
    select e.id,
      case
        when e.contest_id is null then 'names no contest'
        when (select count(*) from journal_lines l where l.entry_id = e.id) <> 2 then 'does not have exactly two lines'
        else 'does not debit its own contest''s escrow and credit the platform fee account'
      end as reason
    from journal_entries e
    where e.kind = 'fee'
      and (
        e.contest_id is null
        or (select count(*) from journal_lines l where l.entry_id = e.id) <> 2
        or not exists (
          select 1 from journal_lines l
          join contests c on c.id = e.contest_id
          where l.entry_id = e.id and l.direction = 'debit'
            and l.account_id = c.escrow_account_id and l.asset = c.asset
        )
        or not exists (
          select 1 from journal_lines l
          join accounts a on a.id = l.account_id
          where l.entry_id = e.id and l.direction = 'credit'
            and a.kind = 'platform_fee' and a.tenant_id = e.tenant_id
        )
      )
    order by e.id
    limit ${LIMIT}
  `);
  if (malformed.length > 0) {
    return {
      ok: false,
      detail: `${malformed.length}${malformed.length === LIMIT ? '+' : ''} fee entries are malformed: ${malformed
        .map((row) => `${row.id} ${row.reason}`)
        .join('; ')}`,
    };
  }

  const drifted = await db.execute<{ id: string; balance: string; fees: string }>(sql`
    select a.id,
      coalesce(sum(${SIGNED}), 0)::text as balance,
      coalesce((
        select sum(case when l2.direction = 'credit' then l2.amount else -l2.amount end)
        from journal_lines l2
        join journal_entries e2 on e2.id = l2.entry_id
        where l2.account_id = a.id and e2.kind = 'fee'
      ), 0)::text as fees
    from accounts a
    left join journal_lines l on l.account_id = a.id
    where a.kind = 'platform_fee'
    group by a.id
    having coalesce(sum(${SIGNED}), 0) <> coalesce((
      select sum(case when l2.direction = 'credit' then l2.amount else -l2.amount end)
      from journal_lines l2
      join journal_entries e2 on e2.id = l2.entry_id
      where l2.account_id = a.id and e2.kind = 'fee'
    ), 0)
    order by a.id
    limit ${LIMIT}
  `);
  if (drifted.length === 0) {
    return { ok: true, detail: `every platform fee account equals the ${count?.fees ?? '0'} fee entries that credited it` };
  }
  return {
    ok: false,
    detail: `${drifted.length}${drifted.length === LIMIT ? '+' : ''} platform fee accounts hold something other than their fee entries: ${drifted
      .map((row) => `${row.id} holds ${row.balance} against ${row.fees} in fees`)
      .join('; ')}`,
  };
}

export const INVARIANTS: readonly InvariantCheck[] = [
  { id: 'I1', name: 'journal nets to zero per asset', check: i1 },
  { id: 'I2', name: 'every entry balances', check: i2 },
  { id: 'I3', name: 'no user wallet is negative', check: i3 },
  { id: 'I4', name: 'settled contests have zero escrow', check: i4 },
  { id: 'I5', name: 'settled payouts equal escrowed total', check: i5 },
  { id: 'I6', name: 'every snapshot equals its derived balance', check: i6 },
  { id: 'I7', name: 'every entry ledger link is a matching escrow entry', check: i7 },
  { id: 'I8', name: 'custody equals deposits less withdrawals', check: i8 },
  { id: 'I9', name: 'platform fee equals the rake taken', check: i9 },
];

/**
 * Run every registered invariant and report. Never throws for a violation; a violation is
 * `ok: false` in the report. A database error does throw, because "could not check" must
 * not read as "clean".
 */
export async function reconcile(db: DbOrTx): Promise<ReconcileReport> {
  const started = performance.now();
  const ranAt = new Date().toISOString();
  const invariants: InvariantResult[] = [];
  for (const invariant of INVARIANTS) {
    if ('check' in invariant) {
      const outcome = await invariant.check(db);
      invariants.push({ id: invariant.id, name: invariant.name, ok: outcome.ok, status: outcome.ok ? 'ok' : 'failed', detail: outcome.detail });
    } else {
      invariants.push({
        id: invariant.id,
        name: invariant.name,
        ok: true,
        status: 'not_applicable',
        detail: invariant.detail,
        notApplicableUntil: invariant.notApplicableUntil,
      });
    }
  }
  return {
    ok: invariants.every((result) => result.ok),
    ranAt,
    durationMs: Math.round(performance.now() - started),
    invariants,
  };
}
