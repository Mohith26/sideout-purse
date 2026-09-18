import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { ApiErrorType } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { operatorFlags, type OperatorFlag, type OperatorFlagKind, type OperatorFlagStatus } from '../db/schema';
import { recordAudit, type Actor } from '../ledger/audit';

/**
 * The review queues (spec 4.6, 4.10): duplicate-identity flags, collusion signals and risk
 * reviews are raised by the engine and resolved by a human in the console. Resolving is
 * the one runtime update (`status`, `reviewed_at`, `reviewed_by`); a resolved flag is
 * never reopened, and its `dedupe_key` keeps the same finding from being raised again.
 */
export const FLAG_ERROR_CODES = { flag_not_found: 'invalid_request', flag_already_reviewed: 'invalid_state', invalid_input: 'invalid_request' } as const satisfies Record<string, ApiErrorType>;

export class FlagError extends Error {
  override readonly name = 'FlagError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: keyof typeof FLAG_ERROR_CODES,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = FLAG_ERROR_CODES[code];
  }
}

export type ListFlagsInput = { tenantId?: Id<'tnt'>; status?: OperatorFlagStatus; kind?: OperatorFlagKind; userId?: string; limit?: number };

export const FLAG_LIST_LIMIT_MAX = 200;

/** Newest first. `userId` matches the subject or either side of a flagged pair. */
export async function listFlags(db: DbOrTx, input: ListFlagsInput = {}): Promise<OperatorFlag[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), FLAG_LIST_LIMIT_MAX);
  const conditions: SQL[] = [];
  if (input.tenantId !== undefined) conditions.push(eq(operatorFlags.tenantId, input.tenantId));
  if (input.status !== undefined) conditions.push(eq(operatorFlags.status, input.status));
  if (input.kind !== undefined) conditions.push(eq(operatorFlags.kind, input.kind));
  if (input.userId !== undefined) conditions.push(sql`(${operatorFlags.subject} = ${input.userId} or ${operatorFlags.detail}->'users' ? ${input.userId})`);
  return db
    .select()
    .from(operatorFlags)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(operatorFlags.createdAt), desc(operatorFlags.id))
    .limit(limit);
}

export async function getFlag(db: DbOrTx, flagId: string, tenantId?: Id<'tnt'>): Promise<OperatorFlag> {
  const [row] = await db
    .select()
    .from(operatorFlags)
    .where(tenantId === undefined ? eq(operatorFlags.id, flagId) : and(eq(operatorFlags.id, flagId), eq(operatorFlags.tenantId, tenantId)));
  if (row === undefined) throw new FlagError('flag_not_found', `No operator flag ${flagId}`, { flagId });
  return row;
}

export type ReviewFlagInput = {
  tenantId: Id<'tnt'>;
  flagId: string;
  /** `reviewed` (looked at, acted on elsewhere) or `dismissed` (not a finding). */
  status: Exclude<OperatorFlagStatus, 'open'>;
  note?: string;
  actor: Actor;
  requestId?: string;
};

const NOTE_MAX = 500;

/** Close a flag once. A second review with the same outcome returns the row; a different outcome is refused. */
export async function reviewFlag(db: DbOrTx, input: ReviewFlagInput): Promise<OperatorFlag> {
  const note = input.note ?? null;
  if (note !== null && (note.trim() === '' || note.length > NOTE_MAX)) {
    throw new FlagError('invalid_input', `note must be 1 to ${NOTE_MAX} characters when given`, { field: 'note' });
  }
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(operatorFlags).where(and(eq(operatorFlags.id, input.flagId), eq(operatorFlags.tenantId, input.tenantId))).for('update');
    if (before === undefined) throw new FlagError('flag_not_found', `No operator flag ${input.flagId}`, { flagId: input.flagId });
    if (before.status !== 'open') {
      if (before.status === input.status) return before;
      throw new FlagError('flag_already_reviewed', `Flag ${before.id} was already ${before.status}`, { flagId: before.id, status: before.status });
    }
    const reviewedBy = input.actor.ref === undefined ? input.actor.kind : `${input.actor.kind}:${input.actor.ref}`;
    const [after] = await tx
      .update(operatorFlags)
      .set({ status: input.status, reviewedAt: sql`now()`, reviewedBy, updatedAt: sql`now()` })
      .where(eq(operatorFlags.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`operator_flags update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: input.status === 'dismissed' ? 'operator_flag.dismissed' : 'operator_flag.reviewed',
      subject: before.id,
      before: { status: before.status, kind: before.kind, subject: before.subject },
      after: { status: after.status, reviewedBy, ...(note === null ? {} : { note }) },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}
