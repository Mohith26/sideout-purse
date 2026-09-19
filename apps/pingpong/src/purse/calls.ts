import { and, desc, eq, lt } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../db/client';
import { purseCalls, type PurseCall } from '../db/schema';
import type { CallOutcome, CallRecorder, CallStart } from './client';

/**
 * The `purse_calls` audit: one row per request to Purse, written on its own connection
 * before the request leaves and completed when it returns, so a row exists for a call
 * that never came back. Always on the pool, never inside a caller's transaction: a call
 * that a rolled-back transaction caused still happened.
 */
export function databaseCallRecorder(db: Db): CallRecorder {
  return {
    async begin(call: CallStart): Promise<string> {
      const id = newId('ppc');
      await db.insert(purseCalls).values({
        id,
        requestId: call.requestId,
        method: call.method,
        path: call.path,
        idempotencyKey: call.idempotencyKey,
        subjectType: call.subject?.type ?? null,
        subjectId: call.subject?.id ?? null,
        requestBody: call.requestBody,
        status: 'in_flight',
        startedAt: call.startedAt,
      });
      return id;
    },
    async finish(callId: string, outcome: CallOutcome): Promise<void> {
      const [started] = await db.select({ startedAt: purseCalls.startedAt }).from(purseCalls).where(eq(purseCalls.id, callId));
      const durationMs = started === undefined ? null : Math.max(0, outcome.finishedAt.getTime() - started.startedAt.getTime());
      await db
        .update(purseCalls)
        .set(
          outcome.status === 'failed'
            ? { status: 'failed', error: outcome.error, responseStatus: outcome.responseStatus, responseBody: outcome.responseBody, finishedAt: outcome.finishedAt, durationMs }
            : { status: outcome.status, responseStatus: outcome.responseStatus, responseBody: outcome.responseBody, replayed: outcome.replayed, finishedAt: outcome.finishedAt, durationMs },
        )
        .where(eq(purseCalls.id, callId));
    },
  };
}

export type PurseCallView = {
  id: string;
  requestId: string;
  method: string;
  path: string;
  idempotencyKey: string | null;
  subject: { type: string; id: string } | null;
  status: PurseCall['status'];
  responseStatus: number | null;
  replayed: boolean | null;
  error: string | null;
  startedAt: string;
  durationMs: number | null;
};

export function toPurseCallView(row: PurseCall): PurseCallView {
  return {
    id: row.id,
    requestId: row.requestId,
    method: row.method,
    path: row.path,
    idempotencyKey: row.idempotencyKey,
    subject: row.subjectType !== null && row.subjectId !== null ? { type: row.subjectType, id: row.subjectId } : null,
    status: row.status,
    responseStatus: row.responseStatus,
    replayed: row.replayed,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
  };
}

/** Newest first, `limit` at a time; `before` (an id) pages back, `subject` narrows to one season, match or player. */
export async function listPurseCalls(db: Db, options: { limit: number; before?: string | undefined; subject?: { type: string; id: string } | undefined }): Promise<{ calls: PurseCallView[]; nextBefore: string | null }> {
  const conditions = [];
  if (options.before !== undefined) conditions.push(lt(purseCalls.id, options.before));
  if (options.subject !== undefined) conditions.push(and(eq(purseCalls.subjectType, options.subject.type), eq(purseCalls.subjectId, options.subject.id)));
  const rows = await db
    .select()
    .from(purseCalls)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(purseCalls.startedAt), desc(purseCalls.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return { calls: page.map(toPurseCallView), nextBefore: rows.length > options.limit && last !== undefined ? last.id : null };
}
