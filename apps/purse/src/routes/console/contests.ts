import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { CONTEST_STATES, type ConsoleSettlementResource, type ContestDetailResource, type ContestEntrantResource, type VoidResource } from '@purse/types';
import type { Id } from '@repo/ids';

import { browseContests, closeContest, currentScores, getContest, listParticipants, listResults, previewSettlement, transitionContest, voidContest } from '../../contests';
import { escrowBalance } from '../../contests/settlement';
import type { DbOrTx } from '../../db/client';
import { users } from '../../db/schema';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import { RequestValidationError } from '../../http/errors';
import { contestIdSchema, param } from '../v1/schemas';
import { contestResource, participantResource, previewResource, resultResource, scoreResource, settlementResource } from '../v1/serialize';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { contestSummaryResource } from './serialize';
import { tenantOf } from './tenants';

/**
 * `/console/contests` and `/console/tenants/:tenantId/contests` (spec 4.10): the browser
 * across every tenant by state, one contest with its escrow balance (from the journal),
 * entrants with their entry links, scores and results, and the close flow as the two-step
 * commit of spec 4.7: `preview` computes the frozen settlement with its hash, `close`
 * presents that hash and settles behind it. The operator actor is what lets an
 * `operator_close` contest leave `awaiting_settlement` (spec 4.3). `transition` and `void`
 * are here too: a contest whose results never all arrive is finished from this console.
 */
const browseQuerySchema = z
  .object({
    state: z.enum(CONTEST_STATES).optional(),
    tenantId: z.string().regex(/^tnt_[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const closeSchema = z.object({ payoutHash: z.string().regex(/^[0-9a-f]{64}$/, 'must be the 64-character hex digest from the preview') }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
const transitionSchema = z.object({ to: z.enum(['open', 'locked', 'in_progress', 'awaiting_settlement', 'cancelled']), reason: z.string().trim().min(1).max(500).optional() }).strict();

async function entrants(db: DbOrTx, contestId: string): Promise<ContestEntrantResource[]> {
  const participants = await listParticipants(db, contestId);
  const userIds = [...new Set(participants.map((each) => each.userId))];
  const rows = userIds.length === 0 ? [] : await db.select({ id: users.id, externalId: users.externalId, displayName: users.displayName }).from(users).where(sql`${users.id} in (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return participants.map((each) => {
    const user = byId.get(each.userId);
    return { ...participantResource(each), externalId: user?.externalId ?? '', displayName: user?.displayName ?? null };
  });
}

export function globalContestRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/', async (c) => {
    const query = browseQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new RequestValidationError(query.error, ['query']);
    const browsed = await browseContests(c.get('db'), {
      ...(query.data.tenantId === undefined ? {} : { tenantId: query.data.tenantId as Id<'tnt'> }),
      ...(query.data.state === undefined ? {} : { state: query.data.state }),
      ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    });
    return ok(c, { contests: browsed.map(contestSummaryResource) });
  });

  return routes;
}

export function tenantContestRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/:id', async (c) => {
    const tenant = tenantOf(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const db = c.get('db');
    const contest = await getContest(db, tenant.id as Id<'tnt'>, contestId);
    const [escrow, participants, scores, results] = await Promise.all([escrowBalance(db, contest), entrants(db, contest.id), currentScores(db, contest.id), listResults(db, contest.id)]);
    const body: ContestDetailResource = {
      contest: { ...contestResource(contest, escrow, participants.filter((each) => each.state === 'entered').length), tenantId: tenant.id, tenantName: tenant.name },
      participants,
      scores: scores.map(scoreResource),
      results: results.map(resultResource),
    };
    return ok(c, body);
  });

  routes.get('/:id/preview', async (c) => {
    const tenant = tenantOf(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const preview = await previewSettlement(c.get('db'), { tenantId: tenant.id as Id<'tnt'>, contestId });
    return ok(c, previewResource(preview));
  });

  routes.post('/:id/close', async (c) => {
    const tenant = tenantOf(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const { payoutHash } = parseBody(c, closeSchema);
    const closed = await closeContest(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      contestId,
      payoutHash,
      actor: c.get('actor'),
      idempotencyKey: c.get('idempotencyKey') ?? '',
      requestId: c.get('requestId'),
    });
    c.get('logger').info('contest closed from console', { contestId, payoutHash, replayed: closed.replayed, journalEntryId: closed.entry?.entry.id ?? null });
    const body: ConsoleSettlementResource = { ...(await settlementResource(c.get('db'), closed)), replayed: closed.replayed };
    return ok(c, body);
  });

  routes.post('/:id/transition', async (c) => {
    const tenant = tenantOf(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, transitionSchema);
    const { contest } = await transitionContest(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      contestId,
      to: body.to,
      actor: c.get('actor'),
      idempotencyKey: c.get('idempotencyKey') ?? '',
      requestId: c.get('requestId'),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    const db = c.get('db');
    const participants = await entrants(db, contest.id);
    return ok(c, { ...contestResource(contest, await escrowBalance(db, contest), participants.filter((each) => each.state === 'entered').length), tenantId: tenant.id, tenantName: tenant.name });
  });

  routes.post('/:id/void', async (c) => {
    const tenant = tenantOf(c);
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const { reason } = parseBody(c, reasonSchema);
    const voided = await voidContest(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      contestId,
      actor: c.get('actor'),
      idempotencyKey: c.get('idempotencyKey') ?? '',
      requestId: c.get('requestId'),
      ...(reason === undefined ? {} : { reason }),
    });
    const db = c.get('db');
    const participants = await entrants(db, voided.contest.id);
    const body: VoidResource = {
      contest: contestResource(voided.contest, await escrowBalance(db, voided.contest), participants.filter((each) => each.state === 'entered').length),
      refundJournalEntryIds: voided.refunds.map((refund) => refund.entry.id),
    };
    return ok(c, body);
  });

  return routes;
}
