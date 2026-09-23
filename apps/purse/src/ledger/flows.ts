import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { Asset } from '../db/schema';
import { LedgerError } from './errors';
import { getTenantEntry, postEntry, type PostedEntry } from './post';
import { reverseEntry } from './reverse';

/**
 * The spec 4.2.5 standard flows as typed helpers. Each one is a fixed shape over
 * `postEntry`: the kinds of the accounts on each side are asserted, so a caller cannot
 * issue points into an escrow or settle out of a wallet. The contest engine
 * (`src/contests/`) is their caller: `escrowEntry` and `refundEscrow` on entry and
 * withdrawal, `settleEscrow` and `voidEscrow` at close and void.
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

export type DepositFundsInput = Common & {
  externalSettlementAccountId: string;
  walletAccountId: string;
  amount: bigint;
};

/**
 * Money in (spec 13.2): `debit external_settlement / credit user_wallet`.
 *
 * `external_settlement` is debit-normal, so debiting it *increases* it. That is the point:
 * its balance is the custody position, what the platform holds at the rail and the bank on
 * behalf of its users, and it rises as deposits land and falls as withdrawals leave. The
 * matching credit is the user's claim on that custody, denominated in `CREDIT` at one unit
 * to one US cent. No account of asset `USD` is involved, or exists (decision D3).
 *
 * Invariant I8 holds this account's balance to the payments table's own arithmetic, so the
 * two descriptions of the same dollars cannot drift apart unnoticed.
 */
export function depositFunds(db: DbOrTx, input: DepositFundsInput): Promise<PostedEntry> {
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'deposit',
    description: input.description ?? `Deposit ${input.amount} ${input.asset}`,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountId: input.externalSettlementAccountId, direction: 'debit', amount: input.amount, asset: input.asset, expectKind: 'external_settlement' },
      { accountId: input.walletAccountId, direction: 'credit', amount: input.amount, asset: input.asset, expectKind: 'user_wallet' },
    ],
  });
}

export type WithdrawFundsInput = Common & {
  walletAccountId: string;
  externalSettlementAccountId: string;
  amount: bigint;
};

/**
 * Money out (spec 13.2): `debit user_wallet / credit external_settlement`, the mirror of a
 * deposit. Posted when the withdrawal is approved rather than when the cash actually lands,
 * because the user's claim is extinguished at approval: `postEntry` refuses to overdraw a
 * wallet, so this is also the point at which a withdrawal larger than the balance is
 * rejected by the ledger rather than by a service check that could be forgotten.
 */
export function withdrawFunds(db: DbOrTx, input: WithdrawFundsInput): Promise<PostedEntry> {
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'withdrawal',
    description: input.description ?? `Withdrawal ${input.amount} ${input.asset}`,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountId: input.walletAccountId, direction: 'debit', amount: input.amount, asset: input.asset, expectKind: 'user_wallet' },
      { accountId: input.externalSettlementAccountId, direction: 'credit', amount: input.amount, asset: input.asset, expectKind: 'external_settlement' },
    ],
  });
}

export type TakeRakeInput = Common & {
  escrowAccountId: string;
  platformFeeAccountId: string;
  amount: bigint;
  contestId: Id<'cnt'>;
};

/**
 * The platform's take (spec 13.3): `debit contest_escrow / credit platform_fee`, posted
 * immediately before the settle entry and inside the same transaction.
 *
 * Taking the rake as its own entry rather than as an extra line on the settlement is what
 * keeps the existing invariants true without touching them. I4 still finds an empty escrow
 * (gross less rake less payouts is zero), and I5 still finds payouts equal to what the
 * contest escrowed, because it measures the escrow's non-`settle` movement, which this
 * entry has already reduced by the rake. A settlement therefore only ever distributes the
 * net pool, and the fee is legible as its own line in the journal rather than inferred.
 */
export function takeRake(db: DbOrTx, input: TakeRakeInput): Promise<PostedEntry> {
  if (input.amount <= 0n) {
    throw new LedgerError('non_positive_amount', 'A rake entry must move a positive amount');
  }
  return postEntry(db, {
    tenantId: input.tenantId,
    kind: 'fee',
    description: input.description ?? `Platform fee of ${input.amount} ${input.asset}`,
    idempotencyKey: input.idempotencyKey,
    contestId: input.contestId,
    lines: [
      { accountId: input.escrowAccountId, direction: 'debit', amount: input.amount, asset: input.asset, expectKind: 'contest_escrow' },
      { accountId: input.platformFeeAccountId, direction: 'credit', amount: input.amount, asset: input.asset, expectKind: 'platform_fee' },
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
  tenantId: Id<'tnt'>;
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
    const original = await getTenantEntry(tx, input.tenantId, input.entryId);
    if (original.kind !== 'escrow') {
      throw new LedgerError('not_reversible', `Only an escrow entry can be voided; ${original.id} is a ${original.kind}`, {
        entryId: original.id,
        kind: original.kind,
      });
    }
    return reverseEntry(tx, {
      tenantId: input.tenantId,
      entryId: input.entryId,
      idempotencyKey: input.idempotencyKey,
      kind: 'void',
      description: input.description ?? `Void of ${original.id}: ${original.description}`,
    });
  });
}
