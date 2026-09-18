import { Hono } from 'hono';
import { z } from 'zod';
import type { EntryResource, ResultsResource, ScoresResource, VoidResource, WithdrawalResource } from '@purse/types';
import type { Id } from '@repo/ids';

import {
  closeContest,
  createContest,
  enterContest,
  getContest,
  listResults,
  previewSettlement,
  submitScores,
  transitionContest,
  voidContest,
  withdrawEntry,
} from '../../contests';
import type { ContestState } from '../../db/schema';
import { parseBody } from '../../http/body';
import { ok } from '../../http/envelope';
import { locationInputSchema } from '../../users';
import type { V1Deps, V1Scope } from './scope';
import { contestIdSchema, moneySchema, param, userIdSchema } from './schemas';
import { describeContest, loadContestResource, participantResource, previewResource, resultResource, scoreResource, settlementResource } from './serialize';

/**
 * `/v1/contests` (spec 4.7). Every mutation here is one contest service call under the
 * request's idempotency key; the actor is the authenticated key's. The spec lists `open`
 * and `lock`; `start` and `finish` are the two further plain transitions of spec 4.3 the
 * flow needs (scores are accepted only from `in_progress`), mounted the same way
 * (docs/decisions.md). `preview` and `close` run the same pure settlement function, and
 * `close` requires the preview's hash.
 */
const createSchema = z.object({ entryAmount: moneySchema }).loose();

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

const entrySchema = z
  .object({
    userId: userIdSchema,
    teamRef: z.string().trim().min(1).max(255).nullable().optional(),
    seed: z.number().int().min(1).nullable().optional(),
    location: locationInputSchema.optional(),
  })
  .strict();

const scoreSchema = z
  .object({
    userId: userIdSchema,
    score: z.number().finite().nullable(),
    attemptFinished: z.boolean(),
    sourceRef: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .strict();

const scoresSchema = z.object({ scores: z.array(scoreSchema).min(1).max(1000) }).strict();

const closeSchema = z.object({ payoutHash: z.string().regex(/^[0-9a-f]{64}$/, 'must be the 64-character hex digest from the preview') }).strict();

/** The plain transitions, by route name. */
const TRANSITIONS: Readonly<Record<string, ContestState>> = {
  open: 'open',
  lock: 'locked',
  start: 'in_progress',
  finish: 'awaiting_settlement',
};

export function contestsRoutes(deps: V1Deps) {
  const routes = new Hono<V1Scope>();

  routes.post('/', async (c) => {
    const auth = c.get('auth');
    const { entryAmount, ...rest } = parseBody(c, createSchema);
    const { contest } = await createContest(c.get('db'), {
      ...(rest as Parameters<typeof createContest>[1]),
      entryAmount,
      tenantId: auth.tenant.id as Id<'tnt'>,
      idempotencyKey: c.get('idempotencyKey') ?? '',
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    return ok(c, await describeContest(c.get('db'), contest), 201);
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    return ok(c, await loadContestResource(c.get('db'), auth.tenant.id as Id<'tnt'>, contestId));
  });

  for (const [name, to] of Object.entries(TRANSITIONS)) {
    routes.post(`/:id/${name}`, async (c) => {
      const auth = c.get('auth');
      const contestId = param(contestIdSchema, 'id', c.req.param('id'));
      const { reason } = parseBody(c, reasonSchema);
      const { contest } = await transitionContest(c.get('db'), {
        tenantId: auth.tenant.id as Id<'tnt'>,
        contestId,
        to,
        actor: auth.actor,
        idempotencyKey: c.get('idempotencyKey') ?? '',
        requestId: c.get('requestId'),
        ...(reason === undefined ? {} : { reason }),
      });
      return ok(c, await describeContest(c.get('db'), contest));
    });
  }

  routes.post('/:id/entries', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, entrySchema);
    const entered = await enterContest(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      contestId,
      userId: body.userId,
      teamRef: body.teamRef ?? null,
      seed: body.seed ?? null,
      ...(body.location === undefined ? {} : { location: body.location }),
      providers: { geo: deps.providers.geo, risk: deps.providers.risk },
      idempotencyKey: c.get('idempotencyKey') ?? '',
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    const resource: EntryResource = {
      contest: await describeContest(c.get('db'), entered.contest),
      participant: participantResource(entered.participant),
      eligibility: entered.eligibility,
      journalEntryId: entered.entry.entry.id,
    };
    return ok(c, resource, 201);
  });

  routes.delete('/:id/entries/:userId', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const userId = param(userIdSchema, 'userId', c.req.param('userId'));
    const withdrawn = await withdrawEntry(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      contestId,
      userId,
      idempotencyKey: c.get('idempotencyKey') ?? '',
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    const resource: WithdrawalResource = {
      contest: await describeContest(c.get('db'), withdrawn.contest),
      participant: participantResource(withdrawn.participant),
      refundJournalEntryId: withdrawn.refund.entry.id,
    };
    return ok(c, resource);
  });

  routes.post('/:id/scores', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const body = parseBody(c, scoresSchema);
    const submitted = await submitScores(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      contestId,
      scores: body.scores.map((each) => ({ userId: each.userId, score: each.score, attemptFinished: each.attemptFinished, sourceRef: each.sourceRef ?? null })),
      idempotencyKey: c.get('idempotencyKey') ?? '',
      actor: auth.actor,
      requestId: c.get('requestId'),
    });
    const resource: ScoresResource = {
      contest: await describeContest(c.get('db'), submitted.contest),
      scores: submitted.scores.map(scoreResource),
      settlement: submitted.settlement === null ? null : await settlementResource(c.get('db'), submitted.settlement),
    };
    return ok(c, resource, 201);
  });

  routes.get('/:id/preview', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const preview = await previewSettlement(c.get('db'), { tenantId: auth.tenant.id as Id<'tnt'>, contestId });
    return ok(c, previewResource(preview));
  });

  routes.post('/:id/close', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const { payoutHash } = parseBody(c, closeSchema);
    const closed = await closeContest(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      contestId,
      payoutHash,
      actor: auth.actor,
      idempotencyKey: c.get('idempotencyKey') ?? '',
      requestId: c.get('requestId'),
    });
    return ok(c, await settlementResource(c.get('db'), closed));
  });

  routes.post('/:id/void', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const { reason } = parseBody(c, reasonSchema);
    const voided = await voidContest(c.get('db'), {
      tenantId: auth.tenant.id as Id<'tnt'>,
      contestId,
      actor: auth.actor,
      idempotencyKey: c.get('idempotencyKey') ?? '',
      requestId: c.get('requestId'),
      ...(reason === undefined ? {} : { reason }),
    });
    const resource: VoidResource = { contest: await describeContest(c.get('db'), voided.contest), refundJournalEntryIds: voided.refunds.map((refund) => refund.entry.id) };
    return ok(c, resource);
  });

  routes.get('/:id/results', async (c) => {
    const auth = c.get('auth');
    const contestId = param(contestIdSchema, 'id', c.req.param('id'));
    const contest = await getContest(c.get('db'), auth.tenant.id as Id<'tnt'>, contestId);
    const results = await listResults(c.get('db'), contest.id);
    const resource: ResultsResource = { contestId: contest.id, state: contest.state, settledAt: contest.settledAt?.toISOString() ?? null, results: results.map(resultResource) };
    return ok(c, resource);
  });

  return routes;
}
