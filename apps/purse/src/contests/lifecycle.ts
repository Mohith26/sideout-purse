import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { Contest, ContestState } from '../db/schema';
import type { Actor } from '../ledger/audit';
import { ContestError } from './errors';
import { idempotent } from './idempotency';
import { getContest } from './load';
import { transition } from './transition';

/**
 * The transitions that move no money, as one idempotent operation: open, lock, start,
 * declare results complete, cancel. Settlement (`closeContest`) and voiding (`voidContest`)
 * have their own operations in `settlement.ts` because they post entries first; asking
 * for `settling`, `settled` or `voided` here is refused so that stays true.
 */
export const PLAIN_TRANSITION_TARGETS: ReadonlySet<ContestState> = new Set<ContestState>(['open', 'locked', 'in_progress', 'awaiting_settlement', 'cancelled']);

export type TransitionContestInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  to: ContestState;
  actor: Actor;
  idempotencyKey: string;
  reason?: string;
  requestId?: string;
};

export type TransitionedContest = { contest: Contest; replayed: boolean };

export async function transitionContest(db: DbOrTx, input: TransitionContestInput): Promise<TransitionedContest> {
  if (!PLAIN_TRANSITION_TARGETS.has(input.to)) {
    throw new ContestError('invalid_input', `${input.to} is not a plain transition; use closeContest or voidContest`, { to: input.to });
  }
  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Contest, { contestId: string }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.transition', request: { contestId: input.contestId, to: input.to } },
      {
        run: async () => {
          const { after } = await transition(tx, {
            tenantId: input.tenantId,
            contestId: input.contestId,
            to: input.to,
            actor: input.actor,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });
          return { value: after, record: { contestId: after.id } };
        },
        replay: (record) => getContest(tx, input.tenantId, record.contestId),
      },
    );
    return { contest: value, replayed };
  });
}
