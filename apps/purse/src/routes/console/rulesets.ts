import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { ASSETS, CONTEST_KINDS, RESTRICTION_KINDS, VERIFICATION_STATES, type RulesetTestResource } from '@purse/types';

import { rulesets } from '../../db/schema';
import { activateRuleset, evaluate, parseRuleset, publishRuleset, RulesetError, RULESET_VERSION_SHAPE } from '../../eligibility';
import { parseBody } from '../../http/body';
import { ApiFailure, ok } from '../../http/envelope';
import { moneySchema, param } from '../v1/schemas';
import { requireAdmin } from './auth';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { rulesetResource, rulesetSummaryResource } from './serialize';

/**
 * `/console/rulesets` (spec 4.5, 4.10): the version history, one version's JSON, a new
 * version validated against the ruleset schema (admin), activation with an audit row
 * (admin), and the tester: the pure evaluator run against a sample user, contest, wallet
 * and velocity under any stored version, persisting nothing. These are platform-wide, so
 * they live outside any tenant and are idempotent at the service level: publishing the
 * same body under a used version returns it, a different body is a conflict, and
 * activating the active version changes nothing.
 */
const versionSchema = z.string().regex(RULESET_VERSION_SHAPE, 'must read YYYY.MM.n');

const publishSchema = z.object({ body: z.record(z.string(), z.unknown()), activate: z.boolean().optional() }).strict();

const testSchema = z
  .object({
    rulesetVersion: versionSchema.optional(),
    user: z
      .object({
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        verificationState: z.enum(VERIFICATION_STATES),
        reverifyAfter: z.string().datetime({ offset: true }).nullable().optional(),
        restrictions: z.array(z.object({ kind: z.enum(RESTRICTION_KINDS), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }).nullable() }).strict()).max(20),
        region: z.string().trim().min(2).max(6).nullable(),
      })
      .strict(),
    contest: z.object({ asset: z.enum(ASSETS), entryAmount: moneySchema, kind: z.enum(CONTEST_KINDS) }).strict(),
    wallet: z.object({ balance: moneySchema }).strict(),
    velocity: z.object({ enteredLast24h: moneySchema, enteredLast7d: moneySchema }).strict(),
    asOf: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export function rulesetRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/', async (c) => {
    const rows = await c.get('db').select().from(rulesets).orderBy(desc(rulesets.createdAt), desc(rulesets.version));
    return ok(c, { rulesets: rows.map(rulesetSummaryResource) });
  });

  routes.post('/', requireAdmin(), async (c) => {
    const body = parseBody(c, publishSchema);
    try {
      const published = await publishRuleset(c.get('db'), { body: body.body, ...(body.activate === undefined ? {} : { activate: body.activate }), actor: c.get('actor'), requestId: c.get('requestId') });
      c.get('logger').info('ruleset published from console', { version: published.ruleset.version, created: published.created, active: published.ruleset.active });
      return ok(c, { ...rulesetResource(published.ruleset), created: published.created }, published.created ? 201 : 200);
    } catch (error) {
      throw invalidRuleset(error);
    }
  });

  // The tester is registered before `/:version` so the literal path is not read as a version.
  routes.post('/evaluate', async (c) => {
    const body = parseBody(c, testSchema);
    const db = c.get('db');
    const [row] = body.rulesetVersion === undefined ? await db.select().from(rulesets).where(eq(rulesets.active, true)) : await db.select().from(rulesets).where(eq(rulesets.version, body.rulesetVersion));
    if (row === undefined) {
      throw new ApiFailure({ type: 'invalid_request', code: 'ruleset_not_found', message: body.rulesetVersion === undefined ? 'No ruleset is active' : `No ruleset version ${body.rulesetVersion}` }, 404);
    }
    const asOf = body.asOf ?? new Date().toISOString();
    const decision = evaluate({
      user: {
        dateOfBirth: body.user.dateOfBirth,
        verificationState: body.user.verificationState,
        reverifyAfter: body.user.reverifyAfter ?? null,
        restrictions: body.user.restrictions.map((each) => ({ kind: each.kind, startsAt: each.startsAt, endsAt: each.endsAt })),
        region: body.user.region,
      },
      contest: { asset: body.contest.asset, entryAmount: body.contest.entryAmount, kind: body.contest.kind },
      wallet: { balance: body.wallet.balance },
      velocity: { enteredLast24h: body.velocity.enteredLast24h, enteredLast7d: body.velocity.enteredLast7d },
      ruleset: parseRuleset(row.body),
      asOf,
    });
    const resource: RulesetTestResource = { rulesetVersion: row.version, asOf, decision };
    return ok(c, resource);
  });

  routes.get('/:version', async (c) => {
    const version = param(versionSchema, 'version', c.req.param('version'));
    const [row] = await c.get('db').select().from(rulesets).where(eq(rulesets.version, version));
    if (row === undefined) throw new ApiFailure({ type: 'invalid_request', code: 'ruleset_not_found', message: `No ruleset version ${version}` }, 404);
    return ok(c, rulesetResource(row));
  });

  routes.post('/:version/activate', requireAdmin(), async (c) => {
    const version = param(versionSchema, 'version', c.req.param('version'));
    try {
      const activated = await activateRuleset(c.get('db'), { version, actor: c.get('actor'), requestId: c.get('requestId') });
      c.get('logger').info('ruleset activated from console', { version });
      return ok(c, rulesetResource(activated));
    } catch (error) {
      throw invalidRuleset(error);
    }
  });

  return routes;
}

/** A `RulesetError` from a console write is the operator's mistake (a bad body, a used version), not a server fault. */
function invalidRuleset(error: unknown): unknown {
  if (!(error instanceof RulesetError)) return error;
  const conflict = error.message.includes('already stored with a different body');
  const missing = error.message.startsWith('No ruleset version');
  return new ApiFailure(
    {
      type: conflict ? 'conflict' : 'invalid_request',
      code: conflict ? 'ruleset_version_taken' : missing ? 'ruleset_not_found' : 'invalid_ruleset',
      message: error.message,
      ...(error.issues.length === 0 ? {} : { detail: { issues: error.issues } }),
    },
    conflict ? 409 : missing ? 404 : 400,
  );
}
