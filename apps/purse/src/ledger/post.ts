import { asc, eq, inArray, sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import {
  accounts,
  journalEntries,
  journalLines,
  type Account,
  type AccountKind,
  type JournalEntry,
  type JournalEntryKind,
  type JournalLine,
} from '../db/schema';
import { balancesOf } from './balance';
import { LedgerError } from './errors';
import { requestHash } from './hash';
import {
  mirrorDirection,
  signedDelta,
  validateDescription,
  validateIdempotencyKey,
  validateLines,
  type LineInput,
} from './validate';

/**
 * `postEntry` is the only way value moves. Everything in spec 4.2.2 is enforced here, in
 * one transaction, before commit:
 *
 *   1-4  by `validateLines`, before a connection is even used;
 *   5    by the database role (the runtime cannot UPDATE or DELETE what this inserts);
 *   6    reversals must mirror the entry they reverse, and an entry is reversed once;
 *   7    the idempotency key is unique, and a replay returns the original entry.
 *
 * I3 (no wallet below zero) is enforced at write time, not merely detected: the affected
 * accounts are locked `FOR UPDATE` in id order, so two posts against one wallet serialise
 * and the second sees the first's lines, and a debit that would overdraw is refused.
 *
 * Lock order, so concurrent posts cannot deadlock: the idempotency key's advisory lock,
 * then (for a reversal) the reversed entry's advisory lock, then account rows sorted by
 * id. Callers passing their own transaction should not already hold account row locks.
 */
export type PostEntryInput = {
  tenantId: Id<'tnt'>;
  kind: JournalEntryKind;
  description: string;
  idempotencyKey: string;
  contestId?: Id<'cnt'> | null;
  reversesEntryId?: Id<'je'> | null;
  lines: readonly LineInput[];
};

export type PostedEntry = {
  entry: JournalEntry;
  lines: JournalLine[];
  /** True when the key had been used before and this is the original, not a new entry. */
  replayed: boolean;
};

/**
 * Kinds whose derived balance may never go below zero. `user_wallet` is invariant I3;
 * `contest_escrow` follows because funds held for a contest cannot be less than nothing,
 * and refusing it here means phase 2 cannot refund or settle more than was escrowed.
 * The debit-normal source accounts and the liability accounts run negative by design
 * (issuing points debits `promo_liability`).
 */
export const NON_NEGATIVE_KINDS: ReadonlySet<AccountKind> = new Set<AccountKind>(['user_wallet', 'contest_escrow']);

export async function postEntry(db: DbOrTx, input: PostEntryInput): Promise<PostedEntry> {
  validateIdempotencyKey(input.idempotencyKey);
  validateDescription(input.description);
  const { asset } = validateLines(input.lines);
  const hash = requestHash(fingerprint(input));
  const contestId = input.contestId ?? null;
  const reversesEntryId = input.reversesEntryId ?? null;

  return db.transaction(async (tx) => {
    await advisoryLock(tx, `je:${input.idempotencyKey}`);

    const existing = await findEntryByKey(tx, input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== hash) {
        throw new LedgerError(
          'idempotency_conflict',
          `idempotency_key ${input.idempotencyKey} was already used for a different request`,
          { idempotencyKey: input.idempotencyKey, entryId: existing.id },
        );
      }
      return { entry: existing, lines: await linesOf(tx, existing.id), replayed: true };
    }

    if (reversesEntryId !== null) {
      await advisoryLock(tx, `reverse:${reversesEntryId}`);
      await checkReversal(tx, { ...input, contestId, reversesEntryId });
    }

    const accountIds = [...new Set(input.lines.map((line) => line.accountId))].sort();
    const locked = await lockAccounts(tx, accountIds);
    const byId = new Map(locked.map((account) => [account.id, account]));

    const deltas = new Map<string, bigint>();
    input.lines.forEach((line, index) => {
      const account = byId.get(line.accountId);
      if (account === undefined) {
        throw new LedgerError('account_not_found', `Line ${index + 1}: no account ${line.accountId}`, {
          line: index + 1,
          accountId: line.accountId,
        });
      }
      if (account.tenantId !== input.tenantId) {
        throw new LedgerError('account_wrong_tenant', `Line ${index + 1}: account belongs to another tenant`, {
          line: index + 1,
          accountId: line.accountId,
        });
      }
      if (account.status !== 'open') {
        throw new LedgerError('account_not_open', `Line ${index + 1}: account is ${account.status}`, {
          line: index + 1,
          accountId: line.accountId,
          status: account.status,
        });
      }
      if (account.asset !== asset) {
        throw new LedgerError(
          'account_asset_mismatch',
          `Line ${index + 1}: account holds ${account.asset}, entry is in ${asset}`,
          { line: index + 1, accountId: line.accountId, accountAsset: account.asset, asset },
        );
      }
      if (line.expectKind !== undefined && account.kind !== line.expectKind) {
        throw new LedgerError('account_kind_mismatch', `Line ${index + 1}: expected a ${line.expectKind}, got ${account.kind}`, {
          line: index + 1,
          accountId: line.accountId,
          expected: line.expectKind,
          actual: account.kind,
        });
      }
      deltas.set(account.id, (deltas.get(account.id) ?? 0n) + signedDelta(account.normalSide, line.direction, line.amount));
    });

    await refuseOverdrafts(tx, byId, deltas);

    let inserted: JournalEntry | undefined;
    try {
      [inserted] = await tx
        .insert(journalEntries)
        .values({
          id: newId('je'),
          tenantId: input.tenantId,
          kind: input.kind,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          contestId,
          reversesEntryId,
          // The time the lines were written, after every lock was taken, so for any one
          // account posted_at order is commit order. created_at keeps the transaction start.
          postedAt: sql`clock_timestamp()`,
        })
        .returning();
    } catch (error) {
      throw translateConstraint(error, reversesEntryId);
    }
    if (inserted === undefined) throw new Error('journal_entries insert returned no row');
    const entry = inserted;

    const lines = await tx
      .insert(journalLines)
      .values(
        input.lines.map((line, index) => ({
          id: newId('jl'),
          entryId: entry.id,
          accountId: line.accountId,
          direction: line.direction,
          amount: line.amount,
          asset: line.asset,
          sequence: index + 1,
        })),
      )
      .returning();
    lines.sort((a, b) => a.sequence - b.sequence);

    return { entry, lines, replayed: false };
  });
}

/** The parts of a request that make it "the same request" for idempotency purposes. */
function fingerprint(input: PostEntryInput) {
  return {
    tenantId: input.tenantId,
    kind: input.kind,
    description: input.description,
    contestId: input.contestId ?? null,
    reversesEntryId: input.reversesEntryId ?? null,
    lines: input.lines.map((line) => ({
      accountId: line.accountId,
      direction: line.direction,
      amount: line.amount,
      asset: line.asset,
    })),
  };
}

async function advisoryLock(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function findEntryByKey(db: DbOrTx, idempotencyKey: string): Promise<JournalEntry | undefined> {
  const [row] = await db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, idempotencyKey));
  return row;
}

export async function getEntry(db: DbOrTx, entryId: string): Promise<JournalEntry> {
  const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
  if (row === undefined) throw new LedgerError('entry_not_found', `No journal entry ${entryId}`, { entryId });
  return row;
}

export async function linesOf(db: DbOrTx, entryId: string): Promise<JournalLine[]> {
  return db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).orderBy(asc(journalLines.sequence));
}

/** The entry that reverses `entryId`, if one exists. */
export async function reversalOf(db: DbOrTx, entryId: string): Promise<JournalEntry | undefined> {
  const [row] = await db.select().from(journalEntries).where(eq(journalEntries.reversesEntryId, entryId));
  return row;
}

/** Lock the accounts a post touches, in id order, so concurrent posts wait rather than deadlock. */
async function lockAccounts(tx: DbOrTx, accountIds: string[]): Promise<Account[]> {
  return tx.select().from(accounts).where(inArray(accounts.id, accountIds)).orderBy(asc(accounts.id)).for('update');
}

/** Spec I3 at write time: a net debit on a non-negative account must be covered by its balance. */
async function refuseOverdrafts(tx: DbOrTx, byId: Map<string, Account>, deltas: Map<string, bigint>): Promise<void> {
  const guarded = [...deltas].filter(([id, delta]) => {
    const account = byId.get(id);
    return delta < 0n && account !== undefined && NON_NEGATIVE_KINDS.has(account.kind);
  });
  if (guarded.length === 0) return;

  const balances = await balancesOf(
    tx,
    guarded.map(([id]) => id),
  );
  for (const [id, delta] of guarded) {
    const balance = balances.get(id) ?? 0n;
    if (balance + delta < 0n) {
      throw new LedgerError('insufficient_funds', `Account ${id} holds ${balance}, entry would take ${-delta}`, {
        accountId: id,
        balance: balance.toString(),
        requested: (-delta).toString(),
        shortfall: (-(balance + delta)).toString(),
      });
    }
  }
}

/**
 * Rule 6. A reversal must point at an entry of the same tenant and contest that has not
 * been reversed, and its lines must be that entry's lines with every direction flipped:
 * same accounts, same amounts, same asset. Nothing else counts as a correction.
 */
async function checkReversal(
  tx: DbOrTx,
  input: PostEntryInput & { contestId: Id<'cnt'> | null; reversesEntryId: Id<'je'> },
): Promise<void> {
  const original = await getEntry(tx, input.reversesEntryId);
  if (original.tenantId !== input.tenantId) {
    throw new LedgerError('entry_wrong_tenant', `Entry ${original.id} belongs to another tenant`, { entryId: original.id });
  }
  if (original.contestId !== input.contestId) {
    throw new LedgerError('reversal_mismatch', `A reversal must carry the reversed entry's contest`, {
      entryId: original.id,
      expected: original.contestId,
      actual: input.contestId,
    });
  }
  const already = await reversalOf(tx, original.id);
  if (already !== undefined) {
    throw new LedgerError('already_reversed', `Entry ${original.id} was already reversed by ${already.id}`, {
      entryId: original.id,
      reversedBy: already.id,
    });
  }

  const expected = (await linesOf(tx, original.id)).map(
    (line) => `${line.accountId}|${mirrorDirection(line.direction)}|${line.amount}|${line.asset}`,
  );
  const actual = input.lines.map((line) => `${line.accountId}|${line.direction}|${line.amount}|${line.asset}`);
  expected.sort();
  actual.sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new LedgerError('reversal_mismatch', `A reversal's lines must mirror the reversed entry's lines exactly`, {
      entryId: original.id,
    });
  }
}

/**
 * The one constraint that can still fire after the checks above: two reversals of the
 * same entry under different keys racing past `reversalOf`. The advisory lock makes that
 * unreachable in practice; this keeps the answer right if it ever were.
 */
function translateConstraint(error: unknown, reversesEntryId: Id<'je'> | null): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  const pg = cause as { code?: unknown; constraint_name?: unknown } | undefined;
  if (pg?.code === '23505' && pg.constraint_name === 'journal_entries_reverses_entry_id_key' && reversesEntryId !== null) {
    return new LedgerError('already_reversed', `Entry ${reversesEntryId} was already reversed`, { entryId: reversesEntryId });
  }
  return error;
}
