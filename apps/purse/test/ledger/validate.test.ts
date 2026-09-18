import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Asset, LedgerSide } from '../../src/db/schema';
import {
  LedgerError,
  MAX_AMOUNT,
  mirrorDirection,
  signedDelta,
  sumByAsset,
  validateLines,
  type LineInput,
} from '../../src/ledger';

/**
 * Spec 4.2.2 rules 1 to 4 and the 4.2.3 balance arithmetic, checked against generated
 * input rather than examples. No database: these are the pure functions `postEntry` runs
 * before it opens a transaction.
 */
const ASSETS: Asset[] = ['POINTS', 'CREDIT'];
const SIDES: LedgerSide[] = ['debit', 'credit'];

const accountId = fc.integer({ min: 0, max: 9 }).map((n) => `acct_${n}`);
const positive = fc.bigInt({ min: 1n, max: 1_000_000_000n });
const side = fc.constantFrom(...SIDES);
const asset = fc.constantFrom(...ASSETS);

const line = (fixedAsset?: Asset) =>
  fc.record<LineInput>({
    accountId,
    direction: side,
    amount: positive,
    asset: fixedAsset === undefined ? asset : fc.constant(fixedAsset),
  });

/**
 * A balanced entry in one asset: a random set of debit lines, then credit lines that
 * split the same total, shuffled so the order carries no information.
 */
const balancedEntry = asset.chain((a) =>
  fc
    .tuple(fc.array(positive, { minLength: 1, maxLength: 6 }), fc.array(positive, { minLength: 1, maxLength: 6 }))
    .chain(([debits, creditWeights]) => {
      const total = debits.reduce((sum, amount) => sum + amount, 0n);
      // Split `total` across the credit lines in proportion to the weights, remainder on the last.
      const weightSum = creditWeights.reduce((sum, w) => sum + w, 0n);
      const credits = creditWeights.map((w) => (total * w) / weightSum);
      const assigned = credits.reduce((sum, c) => sum + c, 0n);
      credits[credits.length - 1] = (credits[credits.length - 1] ?? 0n) + (total - assigned);
      const lines: LineInput[] = [
        ...debits.map((amount) => ({ accountId: 'acct_d', direction: 'debit' as const, amount, asset: a })),
        ...credits.filter((amount) => amount > 0n).map((amount) => ({ accountId: 'acct_c', direction: 'credit' as const, amount, asset: a })),
      ];
      return fc.shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length }).map((shuffled) => ({ lines: shuffled, total, asset: a }));
    }),
);

function rejects(lines: readonly LineInput[]): LedgerError {
  try {
    validateLines(lines);
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw error;
  }
  throw new Error('expected validateLines to throw');
}

describe('validateLines', () => {
  it('accepts every balanced, positive, single-asset set of at least two lines', () => {
    fc.assert(
      fc.property(balancedEntry, ({ lines, total, asset: a }) => {
        expect(validateLines(lines)).toEqual({ asset: a, total });
      }),
      { numRuns: 500 },
    );
  });

  it('rejects any set of lines that does not balance per asset', () => {
    fc.assert(
      fc.property(fc.array(line(), { minLength: 2, maxLength: 8 }), (lines) => {
        const totals = sumByAsset(lines);
        const unbalanced = [...totals.values()].some(({ debit, credit }) => debit !== credit);
        fc.pre(unbalanced);
        const error = rejects(lines);
        expect(['unbalanced', 'mixed_assets']).toContain(error.code);
        // With one asset the reason is always the imbalance itself.
        if (totals.size === 1) expect(error.code).toBe('unbalanced');
      }),
      { numRuns: 500 },
    );
  });

  it('rejects a balanced set that mixes assets (rule 3)', () => {
    fc.assert(
      fc.property(balancedEntry, balancedEntry, (first, second) => {
        fc.pre(first.asset !== second.asset);
        expect(rejects([...first.lines, ...second.lines]).code).toBe('mixed_assets');
      }),
      { numRuns: 200 },
    );
  });

  it('rejects fewer than two lines (rule 1), even a single "balanced" zero-sum pair is not one line', () => {
    expect(rejects([]).code).toBe('too_few_lines');
    fc.assert(
      fc.property(line(), (one) => {
        expect(rejects([one]).code).toBe('too_few_lines');
      }),
    );
  });

  it('rejects zero, negative and oversized amounts (rule 4) before anything else about the set', () => {
    fc.assert(
      fc.property(balancedEntry, fc.bigInt({ min: -1_000_000n, max: 0n }), fc.nat({ max: 20 }), ({ lines }, bad, at) => {
        const index = at % lines.length;
        const broken = lines.map((l, i) => (i === index ? { ...l, amount: bad } : l));
        expect(rejects(broken).code).toBe('non_positive_amount');
      }),
    );
    const huge: LineInput[] = [
      { accountId: 'a', direction: 'debit', amount: MAX_AMOUNT + 1n, asset: 'POINTS' },
      { accountId: 'b', direction: 'credit', amount: MAX_AMOUNT + 1n, asset: 'POINTS' },
    ];
    expect(rejects(huge).code).toBe('amount_too_large');
    const max: LineInput[] = huge.map((l) => ({ ...l, amount: MAX_AMOUNT }));
    expect(validateLines(max)).toEqual({ asset: 'POINTS', total: MAX_AMOUNT });
  });

  it('reports the totals it found so the caller can see the imbalance', () => {
    const error = rejects([
      { accountId: 'a', direction: 'debit', amount: 100n, asset: 'CREDIT' },
      { accountId: 'b', direction: 'credit', amount: 60n, asset: 'CREDIT' },
    ]);
    expect(error.code).toBe('unbalanced');
    expect(error.apiType).toBe('invalid_request');
    expect(error.detail).toEqual({ asset: 'CREDIT', debits: '100', credits: '60' });
  });
});

describe('balance arithmetic (spec 4.2.3)', () => {
  it('a line on the normal side adds, the other side subtracts, and the mirror cancels it', () => {
    fc.assert(
      fc.property(side, side, positive, (normal, direction, amount) => {
        const delta = signedDelta(normal, direction, amount);
        expect(delta === amount || delta === -amount).toBe(true);
        expect(delta > 0n).toBe(direction === normal);
        expect(delta + signedDelta(normal, mirrorDirection(direction), amount)).toBe(0n);
      }),
    );
  });

  it('a balanced entry moves the same magnitude out of one side and into the other', () => {
    // Any balanced entry between a debit-normal account and a credit-normal account
    // raises both balances by the total (that is what "the system nets to zero" means
    // when read per account), which is why issuing points leaves promo_liability
    // negative and the wallet positive by the same amount.
    fc.assert(
      fc.property(balancedEntry, ({ lines, total }) => {
        const promo = lines.filter((l) => l.accountId === 'acct_d').reduce((sum, l) => sum + signedDelta('credit', l.direction, l.amount), 0n);
        const wallet = lines.filter((l) => l.accountId === 'acct_c').reduce((sum, l) => sum + signedDelta('credit', l.direction, l.amount), 0n);
        expect(promo).toBe(-total);
        expect(wallet).toBe(total);
        expect(promo + wallet).toBe(0n);
      }),
    );
  });

  it('sums by asset the way I1 does', () => {
    fc.assert(
      fc.property(fc.array(line(), { maxLength: 12 }), (lines) => {
        const totals = sumByAsset(lines);
        for (const a of ASSETS) {
          const debit = lines.filter((l) => l.asset === a && l.direction === 'debit').reduce((s, l) => s + l.amount, 0n);
          const credit = lines.filter((l) => l.asset === a && l.direction === 'credit').reduce((s, l) => s + l.amount, 0n);
          const found = totals.get(a);
          if (debit === 0n && credit === 0n) expect(found).toBeUndefined();
          else expect(found).toEqual({ debit, credit });
        }
      }),
    );
  });
});
