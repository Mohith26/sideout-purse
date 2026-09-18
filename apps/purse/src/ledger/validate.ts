import type { AccountKind, Asset, LedgerSide } from '../db/schema';
import { LedgerError } from './errors';

/**
 * The pure half of spec 4.2.2: rules 1 to 4 need no database, so they live here where
 * `fast-check` can throw generated line sets at them (`test/ledger/validate.test.ts`).
 * `postEntry` runs these first and only then opens a transaction for the rest.
 */

export type LineInput = {
  accountId: string;
  direction: LedgerSide;
  /** Strictly positive minor units. `direction` carries the sign. */
  amount: bigint;
  asset: Asset;
  /** When set, the account must be of this kind. The typed flows use it so an escrow can never be issued to. */
  expectKind?: AccountKind;
};

/** Postgres `bigint` upper bound. Larger amounts would fail in the database anyway; refuse them here with a clear code. */
export const MAX_AMOUNT = 9_223_372_036_854_775_807n;

export const MIN_LINES = 2;

export type ValidatedLines = {
  /** The one asset every line carries (rule 3). */
  asset: Asset;
  /** Total debited, which equals total credited (rule 2). */
  total: bigint;
};

/**
 * Enforce rules 1 to 4 on a set of lines, throwing the first violation. The order is the
 * order a reader checks by hand: enough lines, each amount sane, one asset, balanced.
 */
export function validateLines(lines: readonly LineInput[]): ValidatedLines {
  const first = lines[0];
  if (first === undefined || lines.length < MIN_LINES) {
    throw new LedgerError('too_few_lines', `An entry needs at least ${MIN_LINES} lines, got ${lines.length}`, {
      lines: lines.length,
    });
  }

  lines.forEach((line, index) => {
    if (typeof line.amount !== 'bigint' || line.amount <= 0n) {
      throw new LedgerError('non_positive_amount', `Line ${index + 1}: amount must be a positive bigint`, {
        line: index + 1,
        amount: typeof line.amount === 'bigint' ? line.amount.toString() : String(line.amount),
      });
    }
    if (line.amount > MAX_AMOUNT) {
      throw new LedgerError('amount_too_large', `Line ${index + 1}: amount exceeds the largest representable value`, {
        line: index + 1,
        amount: line.amount.toString(),
      });
    }
  });

  const assets = [...new Set(lines.map((line) => line.asset))].sort();
  if (assets.length !== 1) {
    throw new LedgerError('mixed_assets', `All lines in an entry must share one asset, got ${assets.join(', ')}`, {
      assets: assets.join(','),
    });
  }
  const asset = first.asset;

  const totals = sumByAsset(lines);
  for (const [each, { debit, credit }] of totals) {
    if (debit !== credit) {
      throw new LedgerError('unbalanced', `Entry does not balance for ${each}: debits ${debit} vs credits ${credit}`, {
        asset: each,
        debits: debit.toString(),
        credits: credit.toString(),
      });
    }
  }

  return { asset, total: totals.get(asset)?.debit ?? 0n };
}

/** Debit and credit totals per asset. Exported for the property tests and for `reconcile()`'s I2 arithmetic. */
export function sumByAsset(lines: readonly LineInput[]): Map<Asset, { debit: bigint; credit: bigint }> {
  const totals = new Map<Asset, { debit: bigint; credit: bigint }>();
  for (const line of lines) {
    const entry = totals.get(line.asset) ?? { debit: 0n, credit: 0n };
    if (line.direction === 'debit') entry.debit += line.amount;
    else entry.credit += line.amount;
    totals.set(line.asset, entry);
  }
  return totals;
}

/**
 * Spec 4.2.3: a balance is the signed sum of an account's lines relative to its normal
 * side. A line on the normal side adds; the other side subtracts. This is the only place
 * that arithmetic is written in TypeScript; `balanceOf` says the same thing in SQL and
 * the tests hold the two to each other.
 */
export function signedDelta(normalSide: LedgerSide, direction: LedgerSide, amount: bigint): bigint {
  return direction === normalSide ? amount : -amount;
}

/** The mirror image of a line: same account, asset and amount, the other side. */
export function mirrorDirection(direction: LedgerSide): LedgerSide {
  return direction === 'debit' ? 'credit' : 'debit';
}

const KEY_MAX = 255;
const DESCRIPTION_MAX = 1000;

export function validateIdempotencyKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > KEY_MAX || /[\s\p{C}]/u.test(key)) {
    throw new LedgerError(
      'invalid_idempotency_key',
      `idempotency_key must be 1 to ${KEY_MAX} characters with no whitespace or control characters`,
    );
  }
}

export function validateDescription(description: string): void {
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > DESCRIPTION_MAX) {
    throw new LedgerError('invalid_description', `description must be 1 to ${DESCRIPTION_MAX} characters`);
  }
}
