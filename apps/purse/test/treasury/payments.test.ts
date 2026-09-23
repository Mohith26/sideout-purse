import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { payments, type PaymentState } from '../../src/db/schema';
import { balanceOf, openAccount, reconcile } from '../../src/ledger';
import { devFundingProvider, devIdentityProvider } from '../../src/providers';
import { addRestriction, startVerification } from '../../src/users';
import {
  addPaymentMethod,
  deposit,
  confirmPayment,
  getPayment,
  listPaymentMethods,
  paymentTrail,
  requestWithdrawal,
  returnPayment,
  treasuryPosition,
  TreasuryError,
  type TreasuryContext,
} from '../../src/treasury';
import { connectMigrator, connectRuntime } from '../helpers';
import { createTenant, createUser, key, wipeLedger } from '../ledger/fixtures';

/**
 * The fiat rail end to end (spec section 14).
 *
 * These are the tests that matter for the claim the treasury makes: a dollar that enters
 * arrives in the ledger exactly once, a dollar that leaves is debited before it moves, the
 * two descriptions of custody never drift, and none of it creates an account of asset
 * `USD` (which `test/ledger/usd.test.ts` independently proves remains impossible).
 */
describe('treasury: the fiat rail', () => {
  let migrator: Database;
  let runtime: Database;
  let tenantId: Id<'tnt'>;
  let context: TreasuryContext;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });

  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  beforeEach(async () => {
    await wipeLedger(migrator);
    tenantId = await createTenant(migrator.db, `treasury-${Date.now()}`);
    context = { tenantId, funding: devFundingProvider(), actor: { kind: 'system' } };
  });

  /** A user with a stored instrument, and optionally a verified identity. */
  async function player(options: { verified?: boolean; brand?: 'visa' | 'bank_account' } = {}) {
    const user = await createUser(migrator.db, tenantId);
    if (options.verified === true) {
      // Through the real state machine, not by writing the row: `user_verification` has a
      // database trigger that refuses a jump straight to `verified`.
      await startVerification(runtime.db, { tenantId, userId: user.id, identity: devIdentityProvider(), issueToken: false });
    }
    const brand = options.brand ?? 'visa';
    const method = await addPaymentMethod(runtime.db, context, {
      userId: user.id,
      brand,
      last4: '4242',
      ...(brand === 'visa' ? { expMonth: 12, expYear: 2030 } : {}),
      providerRef: `tok_${user.id.slice(-12)}`,
    });
    return { user, method };
  }

  async function walletBalance(userId: string): Promise<bigint> {
    const { account } = await openAccount(runtime.db, { tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'CREDIT' });
    return balanceOf(runtime.db, account.id);
  }

  it('a deposit credits the wallet exactly once and leaves custody reconciled', async () => {
    const { user, method } = await player();

    const outcome = await deposit(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 5_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('dep'),
    });

    expect(outcome.payment.state).toBe('captured');
    expect(outcome.payment.direction).toBe('deposit');
    expect(outcome.entry?.entry.kind).toBe('deposit');
    // The user is credited the full amount; the rail's fee is the platform's cost.
    expect(await walletBalance(user.id)).toBe(5_000n);
    expect(outcome.payment.feeUsdCents).toBe(175n); // 2.9% of $50 + 30c
    expect(outcome.result.outcome).toBe('succeeded');

    const position = await treasuryPosition(runtime.db, tenantId);
    expect(position.depositedUsdCents).toBe(5_000n);
    expect(position.netCustodyUsdCents).toBe(5_000n);
    expect(position.ledgerCustodyCredit).toBe(5_000n);
    expect(position.reconciled).toBe(true);
  });

  it('replaying a deposit under the same key charges nothing twice', async () => {
    const { user, method } = await player();
    const idempotencyKey = key('dep-replay');

    const first = await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 2_500n, paymentMethodId: method.id, idempotencyKey });
    const second = await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 2_500n, paymentMethodId: method.id, idempotencyKey });

    expect(second.payment.id).toBe(first.payment.id);
    expect(await walletBalance(user.id)).toBe(2_500n);
    const rows = await runtime.db.select().from(payments).where(eq(payments.tenantId, tenantId));
    expect(rows).toHaveLength(1);
  });

  it('a declined charge leaves a failed payment and no ledger effect', async () => {
    const { user, method } = await player();

    const outcome = await deposit(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 666n, // scripted decline
      paymentMethodId: method.id,
      idempotencyKey: key('dep-decline'),
    });

    expect(outcome.payment.state).toBe('failed');
    expect(outcome.payment.failureCode).toBe('card_declined');
    expect(outcome.payment.journalEntryId).toBeNull();
    expect(outcome.entry).toBeNull();
    expect(await walletBalance(user.id)).toBe(0n);

    // A failed payment is finished, and the trail records both steps.
    const trail = await paymentTrail(runtime.db, outcome.payment.id);
    expect(trail.map((event) => event.toState)).toEqual<PaymentState[]>(['requires_action', 'failed']);
  });

  it('a deposit walks the processor states, so the trail reads like a real one', async () => {
    const { user, method } = await player();
    const outcome = await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 3_000n, paymentMethodId: method.id, idempotencyKey: key('dep-trail-states') });
    const settled = await confirmPayment(runtime.db, context, outcome.payment.id);

    const trail = await paymentTrail(runtime.db, outcome.payment.id);
    expect(trail.map((event) => event.toState)).toEqual<PaymentState[]>(['requires_action', 'authorized', 'captured', 'settled']);
    expect(settled.payment.state).toBe('settled');
  });

  it('a withdrawal debits the wallet at approval, before the cash moves', async () => {
    const { user, method } = await player({ verified: true });
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 10_000n, paymentMethodId: method.id, idempotencyKey: key('fund') });

    const outcome = await requestWithdrawal(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 4_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('wd'),
    });

    // `approved`, not `paid`: the rail answered `pending`, because ACH takes days. The
    // claim is already gone from the wallet; the cash has not moved yet.
    expect(outcome.payment.state).toBe('approved');
    expect(outcome.result.outcome).toBe('pending');
    expect(outcome.entry?.entry.kind).toBe('withdrawal');
    expect(await walletBalance(user.id)).toBe(6_000n);

    const position = await treasuryPosition(runtime.db, tenantId);
    expect(position.netCustodyUsdCents).toBe(6_000n);
    expect(position.reconciled).toBe(true);

    const paid = await confirmPayment(runtime.db, context, outcome.payment.id);
    expect(paid.payment.state).toBe('paid');
    expect(paid.payment.completedAt).not.toBeNull();
  });

  it('the ledger, not a service check, refuses a withdrawal larger than the balance', async () => {
    const { user, method } = await player({ verified: true });
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 5_000n, paymentMethodId: method.id, idempotencyKey: key('fund') });

    const failure = await requestWithdrawal(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 9_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('wd-over'),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeDefined();
    expect(String(failure)).toMatch(/holds 5000, entry would take 9000/);
    expect(await walletBalance(user.id)).toBe(5_000n);
  });

  it('money cannot leave an unverified account', async () => {
    const { user, method } = await player({ verified: false });
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 5_000n, paymentMethodId: method.id, idempotencyKey: key('fund') });

    const failure = await requestWithdrawal(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 2_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('wd-unverified'),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TreasuryError);
    expect((failure as TreasuryError).code).toBe('verification_required');
  });

  it('a self-exclusion stops money moving in either direction', async () => {
    const { user, method } = await player({ verified: true });
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 5_000n, paymentMethodId: method.id, idempotencyKey: key('fund') });
    await addRestriction(migrator.db, { tenantId, userId: user.id, kind: 'self_exclusion', actor: { kind: 'user', ref: user.id } });

    const depositFailure = await deposit(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 1_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('dep-excluded'),
    }).catch((error: unknown) => error);
    const withdrawalFailure = await requestWithdrawal(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 1_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('wd-excluded'),
    }).catch((error: unknown) => error);

    expect((depositFailure as TreasuryError).code).toBe('user_restricted');
    expect((withdrawalFailure as TreasuryError).code).toBe('user_restricted');
  });

  it('refuses an instrument the rail does not accept, and the database refuses it too', async () => {
    const user = await createUser(migrator.db, tenantId);

    const failure = await addPaymentMethod(runtime.db, context, {
      userId: user.id,
      brand: 'mastercard',
      last4: '5454',
      expMonth: 1,
      expYear: 2031,
      providerRef: 'tok_mastercard_1',
    }).catch((error: unknown) => error);
    expect((failure as TreasuryError).code).toBe('instrument_not_supported');

    // The rule survives a bug in the service: the owner role cannot insert one either.
    const direct = await migrator.sql`
      insert into payment_methods (id, tenant_id, user_id, brand, last4, exp_month, exp_year, provider_ref, provider)
      values ('pmt_019b76da-0000-7000-8000-000000000001', ${tenantId}, ${user.id}, 'mastercard', '5454', 1, 2031, 'tok_direct_1', 'dev')
    `.then(() => undefined, (error: unknown) => String(error));
    expect(direct).toMatch(/payment_methods_brand_supported/);
  });

  it('a returned payout restores the claim by reversing its entry', async () => {
    const { user, method } = await player({ verified: true });
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 8_000n, paymentMethodId: method.id, idempotencyKey: key('fund') });
    const out = await requestWithdrawal(runtime.db, context, {
      userId: user.id,
      amountUsdCents: 3_000n,
      paymentMethodId: method.id,
      idempotencyKey: key('wd-return'),
    });

    const returned = await returnPayment(runtime.db, context, out.payment.id, 'account_closed');
    expect(returned.payment.state).toBe('returned');

    const trail = await paymentTrail(runtime.db, out.payment.id);
    expect(trail.map((event) => event.toState)).toEqual<PaymentState[]>(['requested', 'approved', 'returned']);
  });

  it('a terminal payment cannot be moved, even by the owner role', async () => {
    const { user, method } = await player();
    const outcome = await deposit(runtime.db, context, {
      amountUsdCents: 666n,
      userId: user.id,
      paymentMethodId: method.id,
      idempotencyKey: key('dep-terminal'),
    });
    expect(outcome.payment.state).toBe('failed');

    const failure = await migrator.sql`
      update payments set state = 'captured' where id = ${outcome.payment.id}
    `.then(() => undefined, (error: unknown) => String(error));
    expect(failure).toMatch(/is terminal in state failed/);
  });

  it('the payment trail is append-only for the runtime role', async () => {
    const { user, method } = await player();
    const outcome = await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 1_500n, paymentMethodId: method.id, idempotencyKey: key('dep-trail') });

    const failure = await runtime.sql`
      update payment_events set actor = 'tampered' where payment_id = ${outcome.payment.id}
    `.then(() => undefined, (error: unknown) => String(error));
    expect(failure).toMatch(/permission denied/i);

    const stillThere = await getPayment(runtime.db, tenantId, outcome.payment.id);
    expect(stillThere.state).toBe('captured');
  });

  it('stores at most one default instrument per user', async () => {
    const user = await createUser(migrator.db, tenantId);
    await addPaymentMethod(runtime.db, context, { userId: user.id, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, providerRef: 'tok_default_a' });
    await addPaymentMethod(runtime.db, context, { userId: user.id, brand: 'bank_account', last4: '6789', providerRef: 'tok_default_b', makeDefault: true });

    const stored = await listPaymentMethods(runtime.db, tenantId, user.id);
    expect(stored).toHaveLength(2);
    expect(stored.filter((method) => method.isDefault)).toHaveLength(1);
    expect(stored[0]?.brand).toBe('bank_account');
  });

  it('invariant I8 fails the moment custody and the ledger disagree', async () => {
    const { user, method } = await player();
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 4_000n, paymentMethodId: method.id, idempotencyKey: key('dep-i8') });

    const clean = await reconcile(runtime.db);
    expect(clean.invariants.find((invariant) => invariant.id === 'I8')?.ok).toBe(true);
    expect(clean.ok).toBe(true);

    // Rewrite the rail's record of the amount without touching the ledger. Only the owner
    // role can do this, and no production code path can; it is how the check is proven to
    // be a check rather than a tautology.
    await migrator.sql`update payments set amount_usd_cents = 9999 where tenant_id = ${tenantId}`;

    const broken = await reconcile(runtime.db);
    const i8 = broken.invariants.find((invariant) => invariant.id === 'I8');
    expect(i8?.ok).toBe(false);
    expect(i8?.detail).toMatch(/custody does not match the ledger/);
    expect(broken.ok).toBe(false);
  });

  it('no payment, in any state, creates an account of asset USD', async () => {
    const { user, method } = await player({ verified: true });
    await deposit(runtime.db, context, { userId: user.id, amountUsdCents: 6_000n, paymentMethodId: method.id, idempotencyKey: key('dep-usd') });
    await requestWithdrawal(runtime.db, context, { userId: user.id, amountUsdCents: 2_000n, paymentMethodId: method.id, idempotencyKey: key('wd-usd') });

    const rows = await runtime.db.execute<{ n: string }>(sql`select count(*)::text as n from accounts where asset::text = 'USD'`);
    expect(rows[0]?.n).toBe('0');

    // Every payment's wallet leg is the closed-loop claim, never a currency.
    const assets = await runtime.db.execute<{ asset: string }>(sql`select distinct asset::text as asset from payments`);
    expect(assets.map((row) => row.asset)).toEqual(['CREDIT']);
  });
});
