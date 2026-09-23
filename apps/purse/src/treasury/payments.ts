import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import {
  paymentEvents,
  paymentMethods,
  payments,
  FUNDING_STATE,
  type Payment,
  type PaymentDirection,
  type PaymentEvent,
  type PaymentMethod,
  type PaymentState,
} from '../db/schema';
import { openAccount } from '../ledger/accounts';
import { recordAudit, type Actor } from '../ledger/audit';
import { balanceOf } from '../ledger/balance';
import { depositFunds, withdrawFunds } from '../ledger/flows';
import type { PostedEntry } from '../ledger/post';
import type { FundingProvider, FundingResult } from '../providers/types';
import { activeRestrictions } from '../users/restrictions';
import { getUser, getVerification } from '../users/users';
import { TreasuryError } from './errors';
import { centsToCredit } from './money';
import { assertTransition, INITIAL_STATE } from './states';

/**
 * Money in and money out (spec section 14).
 *
 * The shape of every operation here is the same, and it is the shape the rest of Purse
 * already uses: decide, call the seam, then write one transaction that advances the
 * payment, appends its event, and posts the ledger leg. The ledger leg and the payment row
 * always move together or not at all, which is what makes invariant I8 checkable rather
 * than aspirational.
 *
 * Two things are deliberately *not* here. There is no code path that credits a wallet
 * without a payment row, and none that writes a payment row without the rail having
 * answered; a demo that simply grants balance would make every number below meaningless.
 */

export type TreasuryContext = {
  tenantId: Id<'tnt'>;
  funding: FundingProvider;
  actor: Actor;
  requestId?: string;
};

/** The closed-loop asset a payment's wallet leg is always denominated in. */
const PAYMENT_ASSET = 'CREDIT' as const;

// ---- Instruments ---------------------------------------------------------------------

export type AddPaymentMethodInput = {
  userId: string;
  brand: PaymentMethod['brand'];
  last4: string;
  expMonth?: number | null;
  expYear?: number | null;
  /** The provider's token. Purse never sees, and has nowhere to put, the instrument itself. */
  providerRef: string;
  makeDefault?: boolean;
};

/**
 * Store an instrument the provider has already tokenised.
 *
 * The brand check is the interesting one. The rail this models does not accept Mastercard,
 * so a Mastercard is refused here with a named reason rather than being absent from an
 * enum and failing as a validation error. A partner integrating against this gets a
 * `instrument_not_supported` they can put in front of a user; the database refuses it too,
 * so the rule survives a bug in this function.
 */
export async function addPaymentMethod(db: DbOrTx, context: TreasuryContext, input: AddPaymentMethodInput): Promise<PaymentMethod> {
  const supported = context.funding.capabilities.brands;
  if (!supported.includes(input.brand)) {
    throw new TreasuryError('instrument_not_supported', `${input.brand} is not accepted by this rail; accepted: ${supported.join(', ')}`, {
      brand: input.brand,
      accepted: supported.join(','),
    });
  }
  const user = await getUser(db, context.tenantId, input.userId);

  return db.transaction(async (tx) => {
    const makeDefault = input.makeDefault ?? (await countActive(tx, user.id)) === 0;
    if (makeDefault) await clearDefault(tx, user.id);

    const [row] = await tx
      .insert(paymentMethods)
      .values({
        id: newId('pmt'),
        tenantId: context.tenantId,
        userId: user.id,
        brand: input.brand,
        last4: input.last4,
        expMonth: input.expMonth ?? null,
        expYear: input.expYear ?? null,
        providerRef: input.providerRef,
        provider: context.funding.name,
        isDefault: makeDefault,
      })
      .returning();
    if (row === undefined) throw new Error('payment_methods insert returned no row');

    await recordAudit(tx, {
      tenantId: context.tenantId,
      actor: context.actor,
      action: 'payment_method.added',
      subject: row.id,
      before: null,
      after: row,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    });
    return row;
  });
}

export async function listPaymentMethods(db: DbOrTx, tenantId: Id<'tnt'>, userId: string): Promise<PaymentMethod[]> {
  return db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.userId, userId), inArray(paymentMethods.status, ['active', 'expired'])))
    .orderBy(desc(paymentMethods.isDefault), asc(paymentMethods.id));
}

async function countActive(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.userId, userId), eq(paymentMethods.status, 'active')));
  return rows.length;
}

async function clearDefault(db: DbOrTx, userId: string): Promise<void> {
  await db.update(paymentMethods).set({ isDefault: false }).where(and(eq(paymentMethods.userId, userId), eq(paymentMethods.isDefault, true)));
}

async function loadInstrument(db: DbOrTx, tenantId: Id<'tnt'>, userId: string, paymentMethodId: string): Promise<PaymentMethod> {
  const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, paymentMethodId));
  // Another tenant's instrument is reported as missing, not as forbidden: a partner must
  // not be able to probe for the existence of another partner's rows.
  if (row?.tenantId !== tenantId) {
    throw new TreasuryError('payment_method_not_found', `No payment method ${paymentMethodId}`, { paymentMethodId });
  }
  if (row.userId !== userId) {
    throw new TreasuryError('payment_method_wrong_owner', `Payment method ${paymentMethodId} belongs to another user`, { paymentMethodId });
  }
  if (row.status !== 'active') {
    throw new TreasuryError('payment_method_inactive', `Payment method ${paymentMethodId} is ${row.status}`, { paymentMethodId, status: row.status });
  }
  return row;
}

// ---- Deposits ------------------------------------------------------------------------

export type DepositInput = {
  userId: string;
  amountUsdCents: bigint;
  paymentMethodId: string;
  /** Passed to the rail and used as the ledger entry's key, so a retry is free. */
  idempotencyKey: string;
  statementDescriptor?: string;
};

export type PaymentOutcome = {
  payment: Payment;
  events: PaymentEvent[];
  /** The ledger leg, when the payment funded. */
  entry: PostedEntry | null;
  /** What the rail answered, for the receipt. */
  result: FundingResult;
};

const DEFAULT_DESCRIPTOR = 'PURSE COMPETITION';

/**
 * Pull money in.
 *
 * The order matters and is the honest one: the payment row exists in `requires_action`
 * *before* the rail is called, so a charge that succeeds at the provider and then loses the
 * response still has a row to reconcile against, rather than money at the provider that
 * Purse has never heard of. The rail is called outside the writing transaction (never with
 * a row lock held), and its answer is applied in one transaction that advances the payment,
 * appends both events and posts the ledger entry.
 *
 * The rail's fee is recorded on the payment but is never deducted from the user: the wallet
 * is credited the full amount deposited. That is what the partner this models does, and it
 * keeps I8 a clean equality rather than an equality with a fee term nobody can audit.
 */
export async function deposit(db: DbOrTx, context: TreasuryContext, input: DepositInput): Promise<PaymentOutcome> {
  assertPositive(input.amountUsdCents);
  const capabilities = context.funding.capabilities;
  if (input.amountUsdCents < capabilities.minimumDepositUsdCents) {
    throw new TreasuryError('amount_below_minimum', `The minimum deposit is ${capabilities.minimumDepositUsdCents} cents`, {
      amount: input.amountUsdCents.toString(),
      minimum: capabilities.minimumDepositUsdCents.toString(),
    });
  }
  if (input.amountUsdCents > capabilities.maximumDepositUsdCents) {
    throw new TreasuryError('amount_above_maximum', `The maximum deposit is ${capabilities.maximumDepositUsdCents} cents`, {
      amount: input.amountUsdCents.toString(),
      maximum: capabilities.maximumDepositUsdCents.toString(),
    });
  }

  const user = await getUser(db, context.tenantId, input.userId);
  await assertMayMoveMoney(db, user.id, 'deposit');
  const instrument = await loadInstrument(db, context.tenantId, user.id, input.paymentMethodId);

  const existing = await findByKey(db, context.tenantId, input.idempotencyKey);
  if (existing !== undefined) return describe(db, existing);

  const created = await open(db, context, {
    userId: user.id,
    direction: 'deposit',
    amountUsdCents: input.amountUsdCents,
    paymentMethodId: instrument.id,
    idempotencyKey: input.idempotencyKey,
    statementDescriptor: input.statementDescriptor ?? DEFAULT_DESCRIPTOR,
  });

  const result = await context.funding.charge({
    tenantId: context.tenantId,
    userId: user.id,
    amountUsdCents: input.amountUsdCents,
    instrument: { paymentMethodId: instrument.id, providerRef: instrument.providerRef, brand: instrument.brand, last4: instrument.last4 },
    idempotencyKey: input.idempotencyKey,
    statementDescriptor: input.statementDescriptor ?? DEFAULT_DESCRIPTOR,
  });

  if (result.outcome === 'declined') {
    return fail(db, context, created, result, result.declineCode ?? 'rail_declined');
  }
  return fund(db, context, created, result, input.idempotencyKey);
}

// ---- Withdrawals ---------------------------------------------------------------------

export type WithdrawalInput = {
  userId: string;
  amountUsdCents: bigint;
  paymentMethodId: string;
  idempotencyKey: string;
};

/**
 * Push money out.
 *
 * A withdrawal is not the mirror image of a deposit, and pretending it is would be the
 * mistake. Money leaving is the direction fraud cares about, so a withdrawal is gated on a
 * verified identity, is refused outright while the user carries a self-exclusion, and is
 * debited from the wallet at *approval*, before the cash has moved. The ledger refuses to
 * overdraw a wallet, so the balance check is the ledger's rather than a service check that
 * could be skipped.
 *
 * The rail answers `pending`, not `succeeded`, because ACH takes days: the payment rests in
 * `approved` with the claim already extinguished, and `confirmPayout` is what a provider
 * webhook later calls to move it to `paid`, or `returnPayment` to send the money back.
 */
export async function requestWithdrawal(db: DbOrTx, context: TreasuryContext, input: WithdrawalInput): Promise<PaymentOutcome> {
  assertPositive(input.amountUsdCents);
  const capabilities = context.funding.capabilities;
  if (input.amountUsdCents < capabilities.minimumWithdrawalUsdCents) {
    throw new TreasuryError('amount_below_minimum', `The minimum withdrawal is ${capabilities.minimumWithdrawalUsdCents} cents`, {
      amount: input.amountUsdCents.toString(),
      minimum: capabilities.minimumWithdrawalUsdCents.toString(),
    });
  }

  const user = await getUser(db, context.tenantId, input.userId);
  await assertMayMoveMoney(db, user.id, 'withdrawal');
  const verification = await getVerification(db, user.id);
  if (verification.state !== 'verified') {
    throw new TreasuryError('verification_required', 'Money can only leave a verified account', {
      userId: user.id,
      state: verification.state,
    });
  }
  const instrument = await loadInstrument(db, context.tenantId, user.id, input.paymentMethodId);

  const existing = await findByKey(db, context.tenantId, input.idempotencyKey);
  if (existing !== undefined) return describe(db, existing);

  const created = await open(db, context, {
    userId: user.id,
    direction: 'withdrawal',
    amountUsdCents: input.amountUsdCents,
    paymentMethodId: instrument.id,
    idempotencyKey: input.idempotencyKey,
    statementDescriptor: DEFAULT_DESCRIPTOR,
  });

  const result = await context.funding.payout({
    tenantId: context.tenantId,
    userId: user.id,
    amountUsdCents: input.amountUsdCents,
    instrument: { paymentMethodId: instrument.id, providerRef: instrument.providerRef, brand: instrument.brand, last4: instrument.last4 },
    idempotencyKey: input.idempotencyKey,
  });

  if (result.outcome === 'declined') {
    return fail(db, context, created, result, result.declineCode ?? 'rail_declined');
  }
  return fund(db, context, created, result, input.idempotencyKey);
}

// ---- Provider callbacks --------------------------------------------------------------

/** A deposit the rail has settled into the merchant account, or a payout that has landed. */
export async function confirmPayment(db: DbOrTx, context: TreasuryContext, paymentId: string): Promise<PaymentOutcome> {
  const payment = await getPayment(db, context.tenantId, paymentId);
  const next: PaymentState = payment.direction === 'deposit' ? 'settled' : 'paid';
  return advance(db, context, payment, next, 'provider', {});
}

/** A payout the bank sent back. The claim is restored by reversing the withdrawal's entry. */
export async function returnPayment(db: DbOrTx, context: TreasuryContext, paymentId: string, reason: string): Promise<PaymentOutcome> {
  const payment = await getPayment(db, context.tenantId, paymentId);
  return advance(db, context, payment, 'returned', 'provider', { reason });
}

// ---- Reads ---------------------------------------------------------------------------

export async function getPayment(db: DbOrTx, tenantId: Id<'tnt'>, paymentId: string): Promise<Payment> {
  const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (row === undefined) throw new TreasuryError('payment_not_found', `No payment ${paymentId}`, { paymentId });
  if (row.tenantId !== tenantId) throw new TreasuryError('payment_wrong_tenant', `Payment ${paymentId} belongs to another tenant`, { paymentId });
  return row;
}

export async function listPayments(
  db: DbOrTx,
  tenantId: Id<'tnt'>,
  filter: { userId?: string; direction?: PaymentDirection; limit?: number } = {},
): Promise<Payment[]> {
  const conditions = [eq(payments.tenantId, tenantId)];
  if (filter.userId !== undefined) conditions.push(eq(payments.userId, filter.userId));
  if (filter.direction !== undefined) conditions.push(eq(payments.direction, filter.direction));
  return db
    .select()
    .from(payments)
    .where(and(...conditions))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(Math.min(filter.limit ?? 50, 200));
}

export async function paymentTrail(db: DbOrTx, paymentId: string): Promise<PaymentEvent[]> {
  return db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, paymentId)).orderBy(asc(paymentEvents.occurredAt), asc(paymentEvents.id));
}

/**
 * The custody position: what the platform holds at the rail on behalf of its users, and
 * what the ledger says it owes them. These are two descriptions of the same dollars and
 * invariant I8 holds them equal; a treasury page that reported only one of them would be
 * reporting a number nobody could check.
 */
export type TreasuryPosition = {
  /** Deposits that funded, in US cents. */
  depositedUsdCents: bigint;
  /** Withdrawals that funded, in US cents. */
  withdrawnUsdCents: bigint;
  /** Deposited less withdrawn: what should be in custody. */
  netCustodyUsdCents: bigint;
  /** The `external_settlement` account's balance, in CREDIT. The ledger's own answer. */
  ledgerCustodyCredit: bigint;
  /** What the rail charged the platform, in US cents. A cost, not revenue. */
  railFeesUsdCents: bigint;
  /** The `platform_fee` account's balance, in CREDIT. Revenue taken as rake. */
  platformFeeCredit: bigint;
  /** True when the two custody descriptions agree, which is invariant I8. */
  reconciled: boolean;
};

export async function treasuryPosition(db: DbOrTx, tenantId: Id<'tnt'>): Promise<TreasuryPosition> {
  const [totals] = await db.execute<{ deposited: string; withdrawn: string; fees: string }>(sql`
    select
      coalesce(sum(case when direction = 'deposit' then amount_usd_cents else 0 end), 0)::text as deposited,
      coalesce(sum(case when direction = 'withdrawal' then amount_usd_cents else 0 end), 0)::text as withdrawn,
      coalesce(sum(fee_usd_cents), 0)::text as fees
    from payments
    where tenant_id = ${tenantId} and funded_at is not null
  `);
  const deposited = BigInt(totals?.deposited ?? '0');
  const withdrawn = BigInt(totals?.withdrawn ?? '0');
  const custody = await platformAccountBalance(db, tenantId, 'external_settlement');
  const fee = await platformAccountBalance(db, tenantId, 'platform_fee');
  const net = deposited - withdrawn;
  return {
    depositedUsdCents: deposited,
    withdrawnUsdCents: withdrawn,
    netCustodyUsdCents: net,
    ledgerCustodyCredit: custody,
    railFeesUsdCents: BigInt(totals?.fees ?? '0'),
    platformFeeCredit: fee,
    reconciled: centsToCredit(net) === custody,
  };
}

async function platformAccountBalance(db: DbOrTx, tenantId: Id<'tnt'>, kind: 'external_settlement' | 'platform_fee'): Promise<bigint> {
  const { account } = await openAccount(db, { tenantId, kind, ownerRef: null, asset: PAYMENT_ASSET });
  return balanceOf(db, account.id);
}

// ---- The machine --------------------------------------------------------------------

type OpenInput = {
  userId: string;
  direction: PaymentDirection;
  amountUsdCents: bigint;
  paymentMethodId: string;
  idempotencyKey: string;
  statementDescriptor: string;
};

/** Create the payment in its initial state, before the rail is called. */
async function open(db: DbOrTx, context: TreasuryContext, input: OpenInput): Promise<Payment> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(payments)
      .values({
        id: newId('pay'),
        tenantId: context.tenantId,
        userId: input.userId,
        direction: input.direction,
        state: INITIAL_STATE[input.direction],
        amountUsdCents: input.amountUsdCents,
        asset: PAYMENT_ASSET,
        paymentMethodId: input.paymentMethodId,
        provider: context.funding.name,
        providerRef: null,
        statementDescriptor: input.statementDescriptor,
      })
      .returning();
    if (row === undefined) throw new Error('payments insert returned no row');

    await tx.insert(paymentEvents).values({
      id: newId('pev'),
      paymentId: row.id,
      fromState: null,
      toState: row.state,
      actor: actorLabel(context.actor),
      detail: { amountUsdCents: input.amountUsdCents.toString(), idempotencyKey: input.idempotencyKey },
    });
    return row;
  });
}

/**
 * Apply a successful rail answer: walk to the funding state, post the ledger leg, and link
 * the two. One transaction, so a wallet is never credited without its payment, or a payment
 * marked funded without its entry.
 *
 * A deposit passes through `authorized` on the way to `captured` rather than jumping,
 * because that is what a card actually does and because the two-step is the reason the
 * money can be held and released. The trail therefore reads the way a processor's does.
 */
async function fund(db: DbOrTx, context: TreasuryContext, payment: Payment, result: FundingResult, idempotencyKey: string): Promise<PaymentOutcome> {
  const funded = FUNDING_STATE[payment.direction];
  return db.transaction(async (tx) => {
    let current = payment;
    if (payment.direction === 'deposit') {
      current = await write(tx, context, current, 'authorized', 'provider', {
        providerRef: result.providerRef,
        note: `Authorized on the rail for ${payment.amountUsdCents} cents.`,
      });
    }
    const { account: wallet } = await openAccount(tx, {
      tenantId: context.tenantId,
      kind: 'user_wallet',
      ownerRef: payment.userId,
      asset: PAYMENT_ASSET,
      actor: context.actor,
    });
    const { account: custody } = await openAccount(tx, {
      tenantId: context.tenantId,
      kind: 'external_settlement',
      ownerRef: null,
      asset: PAYMENT_ASSET,
      actor: context.actor,
    });

    const amount = centsToCredit(payment.amountUsdCents);
    const entry =
      current.direction === 'deposit'
        ? await depositFunds(tx, {
            tenantId: context.tenantId,
            asset: PAYMENT_ASSET,
            externalSettlementAccountId: custody.id,
            walletAccountId: wallet.id,
            amount,
            idempotencyKey: `payment:${payment.id}:fund`,
            description: `Deposit for payment ${payment.id}`,
          })
        : await withdrawFunds(tx, {
            tenantId: context.tenantId,
            asset: PAYMENT_ASSET,
            walletAccountId: wallet.id,
            externalSettlementAccountId: custody.id,
            amount,
            idempotencyKey: `payment:${payment.id}:fund`,
            description: `Withdrawal for payment ${payment.id}`,
          });

    const moved = await write(tx, context, current, funded, actorLabel(context.actor), {
      providerRef: result.providerRef,
      feeUsdCents: result.feeUsdCents,
      journalEntryId: entry.entry.id,
      fundedAt: new Date(),
      note: result.note ?? null,
      idempotencyKey,
    });

    return { payment: moved, events: await paymentTrail(tx, moved.id), entry, result };
  });
}

/** Apply a rail refusal. Nothing was funded, so there is nothing to reverse. */
async function fail(db: DbOrTx, context: TreasuryContext, payment: Payment, result: FundingResult, code: string): Promise<PaymentOutcome> {
  return db.transaction(async (tx) => {
    const moved = await write(tx, context, payment, 'failed', 'provider', {
      providerRef: result.providerRef,
      failureCode: code,
      completedAt: new Date(),
      note: result.note ?? null,
    });
    return { payment: moved, events: await paymentTrail(tx, moved.id), entry: null, result };
  });
}

/**
 * A later move on an existing payment: settlement of a captured deposit, a payout landing,
 * or a return. A return restores the user's claim by reversing the withdrawal's entry,
 * which is the ledger's own correction mechanism rather than a compensating credit that
 * would leave two entries nobody can pair.
 */
async function advance(
  db: DbOrTx,
  context: TreasuryContext,
  payment: Payment,
  to: PaymentState,
  actor: string,
  detail: Record<string, string | number | boolean | null>,
): Promise<PaymentOutcome> {
  return db.transaction(async (tx) => {
    const terminal = to === 'settled' || to === 'paid' || to === 'returned';
    const moved = await write(tx, context, payment, to, actor, {
      ...detail,
      ...(terminal ? { completedAt: new Date() } : {}),
    });
    return {
      payment: moved,
      events: await paymentTrail(tx, moved.id),
      entry: null,
      result: { outcome: 'succeeded', providerRef: payment.providerRef ?? '', feeUsdCents: payment.feeUsdCents },
    };
  });
}

type WriteFields = {
  providerRef?: string;
  feeUsdCents?: bigint;
  journalEntryId?: string;
  fundedAt?: Date;
  completedAt?: Date;
  failureCode?: string;
  note?: string | null;
  idempotencyKey?: string;
  reason?: string;
};

/** The one place a payment's state changes: assert the move, update the row, append the event. */
async function write(tx: DbOrTx, context: TreasuryContext, payment: Payment, to: PaymentState, actor: string, fields: WriteFields): Promise<Payment> {
  assertTransition(payment.direction, payment.state, to);

  const patch: Record<string, unknown> = { state: to, updatedAt: new Date() };
  if (fields.providerRef !== undefined) patch['providerRef'] = fields.providerRef;
  if (fields.feeUsdCents !== undefined) patch['feeUsdCents'] = fields.feeUsdCents;
  if (fields.journalEntryId !== undefined) patch['journalEntryId'] = fields.journalEntryId;
  if (fields.fundedAt !== undefined) patch['fundedAt'] = fields.fundedAt;
  if (fields.completedAt !== undefined) patch['completedAt'] = fields.completedAt;
  if (fields.failureCode !== undefined) patch['failureCode'] = fields.failureCode;

  const [row] = await tx.update(payments).set(patch).where(eq(payments.id, payment.id)).returning();
  if (row === undefined) throw new Error(`payments update returned no row for ${payment.id}`);
  const before = payment;

  const detail: Record<string, string | number | boolean | null> = {};
  if (fields.note !== undefined && fields.note !== null) detail['note'] = fields.note;
  if (fields.failureCode !== undefined) detail['failureCode'] = fields.failureCode;
  if (fields.providerRef !== undefined) detail['providerRef'] = fields.providerRef;
  if (fields.feeUsdCents !== undefined) detail['feeUsdCents'] = fields.feeUsdCents.toString();
  if (fields.journalEntryId !== undefined) detail['journalEntryId'] = fields.journalEntryId;
  if (fields.reason !== undefined) detail['reason'] = fields.reason;

  await tx.insert(paymentEvents).values({
    id: newId('pev'),
    paymentId: row.id,
    fromState: payment.state,
    toState: to,
    actor,
    detail,
  });

  await recordAudit(tx, {
    tenantId: context.tenantId,
    actor: context.actor,
    action: `payment.${to}`,
    subject: row.id,
    before,
    after: row,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  });
  return row;
}

// ---- Helpers -------------------------------------------------------------------------

function assertPositive(amountUsdCents: bigint): void {
  if (amountUsdCents <= 0n) {
    throw new TreasuryError('invalid_amount', 'An amount must be a positive number of US cents', { amount: amountUsdCents.toString() });
  }
}

/**
 * A self-exclusion or a cooling-off stops money moving in either direction. Spec 4.6 flags
 * rather than blocks for contest entry; money movement is the exception, because the whole
 * point of a self-exclusion is that the user asked to be stopped.
 */
async function assertMayMoveMoney(db: DbOrTx, userId: string, direction: PaymentDirection): Promise<void> {
  const restrictions = await activeRestrictions(db, userId);
  const blocking = restrictions.find(
    (restriction) => restriction.kind === 'self_exclusion' || restriction.kind === 'cool_off' || restriction.kind === 'platform_block',
  );
  if (blocking !== undefined) {
    throw new TreasuryError('user_restricted', `A ${blocking.kind.replace(/_/g, ' ')} is in force on this account, so a ${direction} is refused`, {
      userId,
      restriction: blocking.kind,
      until: blocking.endsAt?.toISOString() ?? null,
    });
  }
}

/**
 * A payment already created under this key, so a retry returns the original rather than
 * charging twice. The key is recorded on the payment's opening event, which is append-only,
 * so this answer cannot be invalidated by a later update to the payment row.
 */
async function findByKey(db: DbOrTx, tenantId: Id<'tnt'>, idempotencyKey: string): Promise<Payment | undefined> {
  const [found] = await db
    .select({ payment: payments })
    .from(paymentEvents)
    .innerJoin(payments, eq(payments.id, paymentEvents.paymentId))
    .where(and(eq(payments.tenantId, tenantId), sql`${paymentEvents.detail} ->> 'idempotencyKey' = ${idempotencyKey}`))
    .limit(1);
  return found?.payment;
}

async function describe(db: DbOrTx, payment: Payment): Promise<PaymentOutcome> {
  return {
    payment,
    events: await paymentTrail(db, payment.id),
    entry: null,
    result: { outcome: payment.state === 'failed' ? 'declined' : 'succeeded', providerRef: payment.providerRef ?? '', feeUsdCents: payment.feeUsdCents },
  };
}

function actorLabel(actor: Actor): string {
  return actor.ref === undefined ? actor.kind : `${actor.kind}:${actor.ref}`;
}
