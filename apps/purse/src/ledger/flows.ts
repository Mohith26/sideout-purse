import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { Asset } from '../db/schema';
import { LedgerError } from './errors';
import { getEntry, postEntry, type PostedEntry } from './post';
import { reverseEntry } from './reverse';

/**
 * The spec 4.2.5 standard flows as typed helpers. Each one is a fixed shape over
 * `postEntry`: the kinds of the accounts on each side are asserted, so a caller cannot
 * issue points into an escrow or settle out of a wallet. Contests call these in phase 2;
 * in phase 1 only the tests do.
 */

type Common = {
  tenantId: Id<'tnt'>;
  asset: Asset;
  idempotencyKey: string;
  description?: string;
};

export type IssuePromoPointsInput = Common & {
  promoLiabilityAccountId: string;
  walletAccountId: string;
  amount: bigint;
};

/** `debit promo_liability / credit user_wallet`. */
export function issuePromoPoints(db: DbOrTx, input: IssuePromoPointsInput): Promise<PostedEntry> {
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'issue',
    description: input.description ?? `Issue ${input.amount} ${input.asset}`,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountId: input.promoLiabilityAccountId, direction: 'debit', amount: input.amount, asset: input.asset, expectKind: 'promo_liability' },
      { accountId: input.walletAccountId, direction: 'credit', amount: input.amount, asset: input.asset, expectKind: 'user_wallet' },
    ],
  });
}

export type EscrowEntryInput = Common & {
  walletAccountId: string;
  escrowAccountId: string;
  amount: bigint;
  contestId?: Id<'cnt'> | null;
};

/** Enter a contest: `debit user_wallet / credit contest_escrow`. Refused when the wallet cannot cover it. */
export function escrowEntry(db: DbOrTx, input: EscrowEntryInput): Promise<PostedEntry> {
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'escrow',
    description: input.description ?? `Escrow ${input.amount} ${input.asset}`,
    idempotencyKey: input.idempotencyKey,
    contestId: input.contestId ?? null,
    lines: [
      { accountId: input.walletAccountId, direction: 'debit', amount: input.amount, asset: input.asset, expectKind: 'user_wallet' },
      { accountId: input.escrowAccountId, direction: 'credit', amount: input.amount, asset: input.asset, expectKind: 'contest_escrow' },
    ],
  });
}

export type RefundEscrowInput = Common & {
  escrowAccountId: string;
  walletAccountId: string;
  amount: bigint;
  contestId?: Id<'cnt'> | null;
};

/** Withdraw before lock: `debit contest_escrow / credit user_wallet`. Refused when the escrow does not hold that much. */
export function refundEscrow(db: DbOrTx, input: RefundEscrowInput): Promise<PostedEntry> {
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'refund',
    description: input.description ?? `Refund ${input.amount} ${input.asset}`,
    idempotencyKey: input.idempotencyKey,
    contestId: input.contestId ?? null,
    lines: [
      { accountId: input.escrowAccountId, direction: 'debit', amount: input.amount, asset: input.asset, expectKind: 'contest_escrow' },
      { accountId: input.walletAccountId, direction: 'credit', amount: input.amount, asset: input.asset, expectKind: 'user_wallet' },
    ],
  });
}

export type Payout = { walletAccountId: string; amount: bigint };

export type SettleEscrowInput = Common & {
  escrowAccountId: string;
  payouts: readonly Payout[];
  contestId?: Id<'cnt'> | null;
};

/**
 * Settle a contest: one entry, one debit of the escrow for the total, one credit line per
 * payout. It balances by construction; `postEntry` still checks. Refused when the payouts
 * exceed what the escrow holds.
 */
export async function settleEscrow(db: DbOrTx, input: SettleEscrowInput): Promise<PostedEntry> {
  if (input.payouts.length === 0) {
    throw new LedgerError('too_few_lines', 'A settlement needs at least one payout');
  }
  const total = input.payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'settle',
    description: input.description ?? `Settle ${total} ${input.asset} to ${input.payouts.length} wallet(s)`,
    idempotencyKey: input.idempotencyKey,
    contestId: input.contestId ?? null,
    lines: [
      { accountId: input.escrowAccountId, direction: 'debit', amount: total, asset: input.asset, expectKind: 'contest_escrow' },
      ...input.payouts.map((payout) => ({
        accountId: payout.walletAccountId,
        direction: 'credit' as const,
        amount: payout.amount,
        asset: input.asset,
        expectKind: 'user_wallet' as const,
      })),
    ],
  });
}

export type VoidEscrowInput = {
  /** The `escrow` entry that put the entrant's stake in. */
  entryId: Id<'je'>;
  idempotencyKey: string;
  description?: string;
};

/**
 * Void one entrant's stake: the reversing entry of their escrow entry, kind `void`. A
 * contest void is one of these per entrant (spec 4.2.5). Only an `escrow` entry can be
 * voided; anything else is a plain `reverseEntry`.
 */
export async function voidEscrow(db: DbOrTx, input: VoidEscrowInput): Promise<PostedEntry> {
  return db.transaction(async (tx) => {
    const original = await getEntry(tx, input.entryId);
    if (original.kind !== 'escrow') {
      throw new LedgerError('not_reversible', `Only an escrow entry can be voided; ${original.id} is a ${original.kind}`, {
        entryId: original.id,
        kind: original.kind,
      });
    }
    return reverseEntry(tx, {
      entryId: input.entryId,
      idempotencyKey: input.idempotencyKey,
      kind: 'void',
      description: input.description ?? `Void of ${original.id}: ${original.description}`,
    });
  });
}
