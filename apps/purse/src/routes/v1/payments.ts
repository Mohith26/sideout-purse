import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { FundingCapabilitiesResource, TreasuryPositionResource } from '@purse/types';
import { isId, type Id } from '@repo/ids';

import { paymentMethodBrand, UNSUPPORTED_BRANDS } from '../../db/schema';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import {
  addPaymentMethod,
  deposit,
  getPayment,
  listPaymentMethods,
  listPayments,
  paymentTrail,
  requestWithdrawal,
  treasuryPosition,
  type TreasuryContext,
} from '../../treasury';
import type { V1Deps, V1Scope } from './scope';
import { param, positiveMoneySchema, userIdSchema } from './schemas';
import { paymentMethodResource, paymentResource } from './serialize';

/**
 * `/v1/payments` and `/v1/treasury` (spec 13.4): the fiat rail as a partner sees it.
 *
 * Every mutation here is idempotent by the same middleware every other `/v1` mutation
 * uses, and the key is passed through to the rail as well, so a retry cannot double-charge
 * at the provider either. The reads are deliberately small: a partner gets the payment, its
 * trail, and the custody position, and nothing that would let it reconstruct another
 * tenant's book.
 */
const paymentIdSchema = z.string().refine((value) => isId(value, 'pay'), 'must be a pay_ id');
const paymentMethodIdSchema = z.string().refine((value) => isId(value, 'pmt'), 'must be a pmt_ id');

const addMethodSchema = z
  .object({
    userId: userIdSchema,
    brand: z.enum(paymentMethodBrand.enumValues),
    last4: z.string().regex(/^[0-9]{4}$/, 'must be four digits'),
    expMonth: z.number().int().min(1).max(12).nullable().optional(),
    expYear: z.number().int().min(2000).max(2100).nullable().optional(),
    /** The provider's token. There is nowhere in this API to send an instrument itself. */
    providerRef: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'must be a provider token'),
    makeDefault: z.boolean().optional(),
  })
  .strict();

const movementSchema = z
  .object({
    userId: userIdSchema,
    amountUsdCents: positiveMoneySchema,
    paymentMethodId: paymentMethodIdSchema,
    statementDescriptor: z.string().trim().min(5).max(22).optional(),
  })
  .strict();

export function paymentsRoutes(deps: V1Deps) {
  const routes = new Hono<V1Scope>();

  const context = (c: Context<V1Scope>): TreasuryContext => {
    const auth = c.get('auth');
    const requestId = c.get('requestId');
    return {
      tenantId: auth.tenant.id as Id<'tnt'>,
      funding: deps.providers.funding,
      actor: auth.actor,
      ...(requestId === undefined ? {} : { requestId }),
    };
  };

  /** What the rail accepts, including what it refuses and why. */
  routes.get('/capabilities', (c) => {
    const funding = deps.providers.funding;
    const resource: FundingCapabilitiesResource = {
      provider: funding.name,
      brands: [...funding.capabilities.brands],
      minimumDepositUsdCents: funding.capabilities.minimumDepositUsdCents.toString(),
      maximumDepositUsdCents: funding.capabilities.maximumDepositUsdCents.toString(),
      minimumWithdrawalUsdCents: funding.capabilities.minimumWithdrawalUsdCents.toString(),
      withdrawalSettlementHours: funding.capabilities.withdrawalSettlementHours,
      unsupported: Object.entries(UNSUPPORTED_BRANDS).map(([brand, reason]) => ({
        brand: brand as (typeof paymentMethodBrand.enumValues)[number],
        reason: reason ?? 'not supported',
      })),
    };
    return ok(c, resource);
  });

  routes.post('/methods', async (c) => {
    const fields = parseBody(c, addMethodSchema);
    const method = await addPaymentMethod(c.get('db'), context(c), {
      userId: fields.userId,
      brand: fields.brand,
      last4: fields.last4,
      providerRef: fields.providerRef,
      ...(fields.expMonth === undefined ? {} : { expMonth: fields.expMonth }),
      ...(fields.expYear === undefined ? {} : { expYear: fields.expYear }),
      ...(fields.makeDefault === undefined ? {} : { makeDefault: fields.makeDefault }),
    });
    return ok(c, paymentMethodResource(method), 201);
  });

  routes.get('/methods/:userId', async (c) => {
    const auth = c.get('auth');
    const userId = param(userIdSchema, 'userId', c.req.param('userId'));
    const methods = await listPaymentMethods(c.get('db'), auth.tenant.id as Id<'tnt'>, userId);
    return ok(c, methods.map(paymentMethodResource));
  });

  routes.post('/deposits', async (c) => {
    const fields = parseBody(c, movementSchema);
    const outcome = await deposit(c.get('db'), context(c), {
      userId: fields.userId,
      amountUsdCents: fields.amountUsdCents,
      paymentMethodId: fields.paymentMethodId,
      idempotencyKey: c.get('idempotencyKey') ?? '',
      ...(fields.statementDescriptor === undefined ? {} : { statementDescriptor: fields.statementDescriptor }),
    });
    return ok(c, paymentResource(outcome.payment, outcome.events), 201);
  });

  routes.post('/withdrawals', async (c) => {
    const fields = parseBody(c, movementSchema);
    const outcome = await requestWithdrawal(c.get('db'), context(c), {
      userId: fields.userId,
      amountUsdCents: fields.amountUsdCents,
      paymentMethodId: fields.paymentMethodId,
      idempotencyKey: c.get('idempotencyKey') ?? '',
    });
    return ok(c, paymentResource(outcome.payment, outcome.events), 201);
  });

  routes.get('/', async (c) => {
    const auth = c.get('auth');
    const userId = c.req.query('userId');
    const direction = c.req.query('direction');
    const payments = await listPayments(c.get('db'), auth.tenant.id as Id<'tnt'>, {
      ...(userId === undefined ? {} : { userId: param(userIdSchema, 'userId', userId) }),
      ...(direction === 'deposit' || direction === 'withdrawal' ? { direction } : {}),
    });
    return ok(c, payments.map((payment) => paymentResource(payment)));
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const paymentId = param(paymentIdSchema, 'id', c.req.param('id'));
    const payment = await getPayment(c.get('db'), auth.tenant.id as Id<'tnt'>, paymentId);
    const events = await paymentTrail(c.get('db'), payment.id);
    return ok(c, paymentResource(payment, events));
  });

  return routes;
}

/** `/v1/treasury`: the custody position, which is invariant I8 as a readable number. */
export function treasuryRoutes() {
  const routes = new Hono<V1Scope>();

  routes.get('/', async (c) => {
    const auth = c.get('auth');
    const position = await treasuryPosition(c.get('db'), auth.tenant.id as Id<'tnt'>);
    const resource: TreasuryPositionResource = {
      depositedUsdCents: position.depositedUsdCents.toString(),
      withdrawnUsdCents: position.withdrawnUsdCents.toString(),
      netCustodyUsdCents: position.netCustodyUsdCents.toString(),
      ledgerCustodyCredit: position.ledgerCustodyCredit.toString(),
      railFeesUsdCents: position.railFeesUsdCents.toString(),
      platformFeeCredit: position.platformFeeCredit.toString(),
      reconciled: position.reconciled,
    };
    return ok(c, resource);
  });

  return routes;
}
