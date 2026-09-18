import { createHash, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import type { Id } from '@repo/ids';

import { findContest, isContestError, previewSettlement, type SettlementPreview } from '../contests';
import type { Db } from '../db/client';
import { reconcile } from '../ledger';
import { ApiFailure, ok } from '../http/envelope';
import type { RequestScope } from '../http/request-id';

/**
 * The internal (operator-side) surface, every route behind one bearer `INTERNAL_API_TOKEN`.
 *
 * `GET /internal/reconcile`, spec 4.2.4: runs every invariant and answers with the report,
 * 200 when clean, 500 in the error envelope (report in `detail`) when not, so a scheduled
 * caller can alarm on the status alone.
 *
 * `GET /internal/contests/:id/preview`, spec 4.7: the frozen settlement preview, computed
 * by the same pure function `close` runs, with the `payoutHash` a close must present. No
 * side effects. Phase 3 mounts the public `GET /contests/:id/preview` on the same service;
 * this exists so the mechanism can be exercised end to end now.
 *
 * Access: when no token is configured the routes are closed (403) in every environment
 * except `test`, where they are open so the harness can exercise them. Never open in
 * production by accident: there is no "development" shortcut.
 */
export type InternalDeps = {
  db: Db;
  internalApiToken: string | undefined;
  nodeEnv: 'development' | 'test' | 'production';
};

/** The preview over the wire: every bigint a decimal string, the contest reduced to what a close needs to know. */
export type PreviewResponse = {
  contest: { id: string; tenantId: string; externalId: string; state: string; asset: string; settlementPolicy: string; tieBreak: string };
  escrowTotal: string;
  entries: Array<{ userId: string; participantState: string; score: number | null; attemptFinished: boolean; seed: number | null; submittedAt: string | null }>;
  payouts: Array<{ userId: string; placement: number; payout: string }>;
  payoutHash: string;
};

export function toPreviewResponse(preview: SettlementPreview): PreviewResponse {
  return {
    contest: {
      id: preview.contest.id,
      tenantId: preview.contest.tenantId,
      externalId: preview.contest.externalId,
      state: preview.contest.state,
      asset: preview.contest.asset,
      settlementPolicy: preview.contest.settlementPolicy,
      tieBreak: preview.contest.tieBreak,
    },
    escrowTotal: preview.escrowTotal.toString(),
    entries: preview.entries.map((entry) => ({
      userId: entry.userId,
      participantState: entry.participantState,
      score: entry.score,
      attemptFinished: entry.attemptFinished,
      seed: entry.seed ?? null,
      submittedAt: entry.submittedAt ?? null,
    })),
    payouts: preview.payouts.map((payout) => ({ userId: payout.userId, placement: payout.placement, payout: payout.payout.toString() })),
    payoutHash: preview.payoutHash,
  };
}

export function internalRoutes(deps: InternalDeps) {
  return new Hono<RequestScope>()
    .get('/internal/reconcile', async (c) => {
      authorize(c.req.header('Authorization'), deps);

      const report = await reconcile(deps.db);
      const logger = c.get('logger');
      if (report.ok) {
        logger.info('reconcile clean', { durationMs: report.durationMs });
        return ok(c, report);
      }
      const failed = report.invariants.filter((result) => !result.ok).map((result) => result.id);
      logger.error('reconcile failed', { failed, invariants: report.invariants.filter((result) => !result.ok) });
      throw new ApiFailure(
        {
          type: 'internal_error',
          code: 'invariant_violation',
          message: `${failed.length} invariant(s) failed: ${failed.join(', ')}`,
          detail: report,
        },
        500,
      );
    })
    .get('/internal/contests/:id/preview', async (c) => {
      authorize(c.req.header('Authorization'), deps);

      const contestId = c.req.param('id');
      // The operator surface is not tenant-scoped: the contest's own tenant is the acting one.
      const contest = await findContest(deps.db, contestId);
      if (contest === undefined) {
        throw new ApiFailure({ type: 'invalid_request', code: 'contest_not_found', message: `No contest ${contestId}`, detail: { contestId } }, 404);
      }
      try {
        const preview = await previewSettlement(deps.db, { tenantId: contest.tenantId as Id<'tnt'>, contestId });
        c.get('logger').info('settlement preview', { contestId, state: preview.contest.state, entrants: preview.entries.length, payoutHash: preview.payoutHash });
        return ok(c, toPreviewResponse(preview));
      } catch (error) {
        if (isContestError(error)) {
          throw new ApiFailure({ type: error.apiType, code: error.code, message: error.message, detail: error.detail });
        }
        throw error;
      }
    });
}

function authorize(header: string | undefined, deps: InternalDeps): void {
  if (deps.internalApiToken === undefined) {
    if (deps.nodeEnv === 'test') return;
    throw new ApiFailure(
      { type: 'permission_error', code: 'internal_api_closed', message: 'INTERNAL_API_TOKEN is not configured; the internal API is closed' },
      403,
    );
  }
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (presented === undefined || !constantTimeEqual(presented, deps.internalApiToken)) {
    throw new ApiFailure(
      { type: 'authentication_error', code: 'invalid_internal_token', message: 'A valid bearer token is required' },
      401,
    );
  }
}

/** Compare digests so the comparison takes the same time whatever the lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
