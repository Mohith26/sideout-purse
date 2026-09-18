import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { OPERATOR_FLAG_KINDS, OPERATOR_FLAG_STATUSES, OPERATOR_RESTRICTION_KINDS, type ConsoleUserResource, type OperatorFlagResource } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../../db/client';
import { asset as assetEnum, eligibilityDecisions, userRestrictions, users, type OperatorFlag } from '../../db/schema';
import { listFlags, reviewFlag } from '../../eligibility';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import { RequestValidationError } from '../../http/errors';
import { findAccount } from '../../ledger/accounts';
import { balanceOf } from '../../ledger/balance';
import { addRestriction, liftRestriction, loadProfile, searchUsers } from '../../users';
import { param, userIdSchema } from '../v1/schemas';
import { userResource } from '../v1/serialize';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { consoleRestrictionResource, flagResource, flaggedUserIds, userSummaryResource } from './serialize';
import { tenantOf } from './tenants';

/**
 * The review queues and restrictions (spec 4.6, 4.10): duplicate-identity flags,
 * collusion signals and risk reviews across every tenant, resolved or dismissed with an
 * audit row; a tenant's users, one user with every restriction, wallet, open flag and
 * recent decision; and the operator's restrictions (`platform_block`, `velocity_lock`,
 * `cool_off`, each with a reason), placed and lifted through the phase 3 services.
 */
const flagsQuerySchema = z
  .object({
    status: z.enum(OPERATOR_FLAG_STATUSES).optional(),
    kind: z.enum(OPERATOR_FLAG_KINDS).optional(),
    tenantId: z.string().regex(/^tnt_[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const reviewSchema = z.object({ status: z.enum(['reviewed', 'dismissed']), note: z.string().trim().min(1).max(500).optional() }).strict();
const flagIdSchema = z.string().regex(/^flg_[0-9a-f-]{36}$/, 'must be an operator flag id (flg_...)');
const restrictionIdSchema = z.string().regex(/^rst_[0-9a-f-]{36}$/, 'must be a restriction id (rst_...)');
const usersQuerySchema = z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();
const emptySchema = z.object({}).strict();

const restrictionSchema = z
  .object({
    kind: z.enum(OPERATOR_RESTRICTION_KINDS),
    reason: z.string().trim().min(1).max(500),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

async function describeFlags(db: DbOrTx, flags: readonly OperatorFlag[]): Promise<OperatorFlagResource[]> {
  const ids = [...new Set(flags.flatMap(flaggedUserIds))];
  const rows = ids.length === 0 ? [] : await db.select({ id: users.id, externalId: users.externalId, displayName: users.displayName }).from(users).where(sql`${users.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return flags.map((flag) =>
    flagResource(
      flag,
      flaggedUserIds(flag).map((id) => byId.get(id) ?? { id, externalId: '', displayName: null }),
    ),
  );
}

export function globalReviewRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/flags', async (c) => {
    const query = flagsQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new RequestValidationError(query.error, ['query']);
    const flags = await listFlags(c.get('db'), {
      ...(query.data.tenantId === undefined ? {} : { tenantId: query.data.tenantId as Id<'tnt'> }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      ...(query.data.kind === undefined ? {} : { kind: query.data.kind }),
      ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    });
    return ok(c, { flags: await describeFlags(c.get('db'), flags) });
  });

  return routes;
}

export function tenantReviewRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.post('/flags/:id/review', async (c) => {
    const tenant = tenantOf(c);
    const flagId = param(flagIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, reviewSchema);
    const reviewed = await reviewFlag(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      flagId,
      status: body.status,
      ...(body.note === undefined ? {} : { note: body.note }),
      actor: c.get('actor'),
      requestId: c.get('requestId'),
    });
    return ok(c, (await describeFlags(c.get('db'), [reviewed]))[0]);
  });

  routes.get('/users', async (c) => {
    const tenant = tenantOf(c);
    const query = usersQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new RequestValidationError(query.error, ['query']);
    const found = await searchUsers(c.get('db'), { tenantId: tenant.id as Id<'tnt'>, ...(query.data.q === undefined ? {} : { query: query.data.q }), ...(query.data.limit === undefined ? {} : { limit: query.data.limit }) });
    return ok(c, { users: found.map(userSummaryResource) });
  });

  routes.get('/users/:userId', async (c) => {
    const tenant = tenantOf(c);
    const tenantId = tenant.id as Id<'tnt'>;
    const userId = param(userIdSchema, 'userId', c.req.param('userId'));
    const db = c.get('db');
    const now = new Date();
    const profile = await loadProfile(db, tenantId, userId, now);
    const restrictions = await db.select().from(userRestrictions).where(eq(userRestrictions.userId, profile.user.id)).orderBy(desc(userRestrictions.startsAt), desc(userRestrictions.id));
    const wallets: ConsoleUserResource['wallets'] = [];
    for (const asset of assetEnum.enumValues) {
      const wallet = await findAccount(db, { tenantId, kind: 'user_wallet', ownerRef: profile.user.id, asset });
      wallets.push({ asset, accountId: wallet?.id ?? null, balance: wallet === undefined ? '0' : (await balanceOf(db, wallet.id)).toString() });
    }
    const openFlags = await listFlags(db, { tenantId, status: 'open', userId: profile.user.id });
    const decisions = await db
      .select()
      .from(eligibilityDecisions)
      .where(and(eq(eligibilityDecisions.userId, profile.user.id), eq(eligibilityDecisions.tenantId, tenantId)))
      .orderBy(desc(eligibilityDecisions.createdAt), desc(eligibilityDecisions.id))
      .limit(20);
    const body: ConsoleUserResource = {
      user: userResource(profile),
      restrictions: restrictions.map((row) => consoleRestrictionResource(row, now)),
      wallets,
      openFlags: await describeFlags(db, openFlags),
      recentDecisions: decisions.map((row) => ({ id: row.id, contestId: row.contestId, allowed: row.allowed, reasons: row.reasons, rulesetVersion: row.rulesetVersion, createdAt: row.createdAt.toISOString() })),
    };
    return ok(c, body);
  });

  routes.post('/users/:userId/restrictions', async (c) => {
    const tenant = tenantOf(c);
    const userId = param(userIdSchema, 'userId', c.req.param('userId'));
    const body = parseBody(c, restrictionSchema);
    const row = await addRestriction(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      userId,
      kind: body.kind,
      reason: body.reason,
      endsAt: body.endsAt === undefined || body.endsAt === null ? null : new Date(body.endsAt),
      actor: c.get('actor'),
      requestId: c.get('requestId'),
    });
    c.get('logger').info('restriction placed from console', { restrictionId: row.id, userId, kind: row.kind });
    return ok(c, consoleRestrictionResource(row, new Date()), 201);
  });

  routes.post('/restrictions/:id/lift', async (c) => {
    const tenant = tenantOf(c);
    const restrictionId = param(restrictionIdSchema, 'id', c.req.param('id'));
    parseBody(c, emptySchema);
    const row = await liftRestriction(c.get('db'), { tenantId: tenant.id as Id<'tnt'>, restrictionId, actor: c.get('actor'), requestId: c.get('requestId') });
    return ok(c, consoleRestrictionResource(row, new Date()));
  });

  return routes;
}
