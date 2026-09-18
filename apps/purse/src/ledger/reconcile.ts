import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../db/client';

/**
 * Spec 4.2.4: the invariants as a `reconcile()` routine. Runs in CI after the seed
 * (`pnpm --filter @purse/api reconcile`), after the randomized operation test, on a
 * schedule in production, and behind `GET /internal/reconcile`. A failing invariant is a
 * hard alarm: the script exits non-zero and the route answers 500.
 *
 * Each invariant is a registry entry that returns `{ ok, detail }`; the report lists all
 * seven every time so the shape is complete before every check exists. I4, I5 and I7 are
 * about contests and settlement and are registered as not applicable until phase 2, which
 * replaces those three entries and nothing else.
 */
export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

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

const PHASE_2 = 'phase 2 (contests and settlement)';

export const INVARIANTS: readonly InvariantCheck[] = [
  { id: 'I1', name: 'journal nets to zero per asset', check: i1 },
  { id: 'I2', name: 'every entry balances', check: i2 },
  { id: 'I3', name: 'no user wallet is negative', check: i3 },
  { id: 'I4', name: 'settled contests have zero escrow', notApplicableUntil: PHASE_2, detail: 'no contests table yet' },
  { id: 'I5', name: 'settled payouts equal escrowed total', notApplicableUntil: PHASE_2, detail: 'no contest_results table yet' },
  { id: 'I6', name: 'every snapshot equals its derived balance', check: i6 },
  { id: 'I7', name: 'every entry ledger link is a matching escrow entry', notApplicableUntil: PHASE_2, detail: 'no contest_participants table yet' },
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
