import { Hono } from 'hono';
import { z } from 'zod';
import type { CreditResource, DeviceResource, VerificationStartResource, WalletResource } from '@purse/types';
import type { Id } from '@repo/ids';

import { asset as assetEnum } from '../../db/schema';
import { requireOperator } from '../../http/auth';
import { parseBody } from '../../http/body';
import { ok, okOnce } from '../../http/envelope';
import { findAccount, openAccount } from '../../ledger/accounts';
import { balanceOf } from '../../ledger/balance';
import { issuePromoPoints } from '../../ledger/flows';
import { listDevices, loadProfile, profileOf, registerDevice, revokeDevice, startVerification, upsertUser, upsertUserSchema } from '../../users';
import type { V1Deps, V1Scope } from './scope';
import { deviceIdSchema, param, positiveMoneySchema, userIdSchema } from './schemas';
import { deviceResource, embedTokenResource, replayedEmbedToken, userResource, verificationResource } from './serialize';

/**
 * `/v1/users` (spec 4.7): create or upsert by external id, read, start verification, read
 * the wallet, and issue credits (operator scope). Money moves only through the ledger's
 * typed flows; identity moves only through the users services. `/:id/devices` is the
 * signed score attestation's registry (spec section 12, item 1): the partner registers a
 * device's public key, lists them, and revokes one.
 */
const emptyBodySchema = z.object({}).strict();

/** The key is validated to the strict JWK shape by the service; the route only bounds it. */
const registerDeviceSchema = z
  .object({
    publicKey: z.record(z.string().max(16), z.string().max(128)),
    label: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();

const revokeDeviceSchema = z.object({ reason: z.string().trim().min(1).max(500).nullable().optional() }).strict();

const creditsSchema = z
  .object({
    asset: z.enum(assetEnum.enumValues),
    amount: positiveMoneySchema,
    description: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export function usersRoutes(deps: V1Deps) {
  const routes = new Hono<V1Scope>();

  routes.post('/', async (c) => {
    const auth = c.get('auth');
    const fields = parseBody(c, upsertUserSchema);
    const { user, created } = await upsertUser(c.get('db'), {
      ...fields,
      tenantId: auth.tenant.id as Id<'tnt'>,
      actor: auth.actor,
      requestId: c.get('requestId'),
      geo: deps.providers.geo,
    });
    const profile = await profileOf(c.get('db'), user);
    return ok(c, userResource(profile), created ? 201 : 200);
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    const profile = await loadProfile(c.get('db'), auth.tenant.id as Id<'tnt'>, userId);
    return ok(c, userResource(profile));
  });

  routes.post('/:id/verification', async (c) => {
    const auth = c.get('auth');
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    // Takes no fields today; an unknown one is refused so a future field cannot be silently ignored.
    parseBody(c, emptyBodySchema);
    const started = await startVerification(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      userId,
      identity: deps.providers.identity,
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    const profile = await profileOf(c.get('db'), started.user);
    if (started.embedToken === undefined) throw new Error('startVerification issued no embed token');
    const body: VerificationStartResource = {
      user: userResource(profile),
      verification: verificationResource(started.verification),
      embedToken: embedTokenResource(started.embedToken),
    };
    return okOnce(c, body, { ...body, embedToken: replayedEmbedToken(body.embedToken) }, 201);
  });

  routes.post('/:id/devices', async (c) => {
    const auth = c.get('auth');
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, registerDeviceSchema);
    const { device, created } = await registerDevice(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      userId,
      publicKey: body.publicKey as Parameters<typeof registerDevice>[1]['publicKey'],
      label: body.label ?? null,
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    const resource: DeviceResource = deviceResource(device);
    return ok(c, resource, created ? 201 : 200);
  });

  routes.get('/:id/devices', async (c) => {
    const auth = c.get('auth');
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    const devices = await listDevices(c.get('db'), auth.tenant.id as Id<'tnt'>, userId);
    return ok(c, { devices: devices.map(deviceResource) });
  });

  routes.post('/:id/devices/:deviceId/revoke', async (c) => {
    const auth = c.get('auth');
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    const deviceId = param(deviceIdSchema, 'deviceId', c.req.param('deviceId'));
    const body = parseBody(c, revokeDeviceSchema);
    const { device } = await revokeDevice(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      userId,
      deviceId,
      reason: body.reason ?? null,
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    return ok(c, deviceResource(device));
  });

  routes.get('/:id/wallet', async (c) => {
    const auth = c.get('auth');
    const tenantId = auth.tenant.id as Id<'tnt'>;
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    const profile = await loadProfile(c.get('db'), tenantId, userId);
    const balances: WalletResource['balances'] = [];
    for (const asset of assetEnum.enumValues) {
      const wallet = await findAccount(c.get('db'), { tenantId, kind: 'user_wallet', ownerRef: profile.user.id, asset });
      balances.push({ asset, balance: wallet === undefined ? '0' : (await balanceOf(c.get('db'), wallet.id)).toString(), accountId: wallet?.id ?? null });
    }
    return ok(c, { userId: profile.user.id, balances } satisfies WalletResource);
  });

  routes.post('/:id/credits', requireOperator(), async (c) => {
    const auth = c.get('auth');
    const tenantId = auth.tenant.id as Id<'tnt'>;
    const userId = param(userIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, creditsSchema);
    const db = c.get('db');
    const profile = await loadProfile(db, tenantId, userId);
    const key = c.get('idempotencyKey') ?? '';
    const requestId = c.get('requestId');

    const { account: promo } = await openAccount(db, { tenantId, kind: 'promo_liability', ownerRef: null, asset: body.asset, actor: auth.actor, requestId });
    const { account: wallet } = await openAccount(db, { tenantId, kind: 'user_wallet', ownerRef: profile.user.id, asset: body.asset, actor: auth.actor, requestId });
    const posted = await issuePromoPoints(db, {
      tenantId,
      asset: body.asset,
      promoLiabilityAccountId: promo.id,
      walletAccountId: wallet.id,
      amount: body.amount,
      idempotencyKey: `credit:${key}`,
      description: body.description ?? `Credit of ${body.amount} ${body.asset} to ${profile.user.id}`,
    });
    const balance = await balanceOf(db, wallet.id);
    const resource: CreditResource = { userId: profile.user.id, asset: body.asset, amount: body.amount.toString(), journalEntryId: posted.entry.id, balance: balance.toString() };
    return ok(c, resource, 201);
  });

  return routes;
}
