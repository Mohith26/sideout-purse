import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { contestParticipants, contestResults, contests, type Contest, type ContestState } from '../db/schema';
import { recordAudit, type Actor } from '../ledger/audit';
import { balanceOf } from '../ledger/balance';
import { ContestError } from './errors';
import { lockContest } from './load';
import { assertTransition, TRANSITION_ACTIONS } from './states';

/**
 * The single state writer (spec 4.3 MUST). Nothing else in Purse assigns
 * `contests.state`; `test/contests/transition.test.ts` greps the source tree to keep it
 * that way. It:
 *
 *   1. takes `SELECT ... FOR UPDATE` on the contest row (`lockContest`), so concurrent
 *      transitions serialise and the second one sees the first's result;
 *   2. validates the source state against the table in `states.ts` and the actor
 *      (a `user` never; an operator to leave `awaiting_settlement` under `operator_close`);
 *   3. checks the destination's guard: nothing is held for `cancelled`, the escrow is empty
 *      for `settled` and `voided`, and every placed entrant has a result for `settled`;
 *   4. writes the row and one `audit_log` row with the contest before and after.
 *
 * Pass the transaction of the operation the transition belongs to: `closeContest` enters
 * and leaves `settling` inside its settlement transaction, under this same lock, which is
 * what makes double settlement impossible. If that transaction fails, `settling` was
 * never committed.
 */
export type TransitionInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  to: ContestState;
  actor: Actor;
  /** Why, for the audit row: "locks_at reached", "all expected results present", an operator's note. */
  reason?: string;
  requestId?: string;
};

export type Transitioned = { before: Contest; after: Contest };

export async function transition(db: DbOrTx, input: TransitionInput): Promise<Transitioned> {
  return db.transaction(async (tx) => {
    const before = await lockContest(tx, input.tenantId, input.contestId);
    assertTransition(before, input.to, input.actor);
    await assertGuard(tx, before, input.to);

    const [after] = await tx
      .update(contests)
      .set({
        state: input.to,
        settledAt: input.to === 'settled' ? sql`now()` : before.settledAt,
        updatedAt: sql`now()`,
      })
      .where(eq(contests.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`contests update of ${before.id} returned no row`);

    await recordAudit(tx, {
      tenantId: before.tenantId as Id<'tnt'>,
      actor: input.actor,
      action: TRANSITION_ACTIONS[input.to],
      subject: before.id,
      before,
      after: input.reason === undefined ? after : { ...after, reason: input.reason },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { before, after };
  });
}

/**
 * What must already be true of the contest for the destination to be honest. These run
 * inside the caller's transaction, so `settled` sees the settlement entry that was just
 * posted and `voided` sees the refunds.
 */
async function assertGuard(tx: DbOrTx, contest: Contest, to: ContestState): Promise<void> {
  switch (to) {
    case 'cancelled': {
      const held = await activeCount(tx, contest.id);
      if (held > 0) {
        throw new ContestError('contest_has_entries', `Contest ${contest.id} holds ${held} entries; void it to refund them, it cannot be cancelled`, {
          contestId: contest.id,
          entries: held,
        });
      }
      await assertEscrowEmpty(tx, contest, to);
      return;
    }
    case 'voided':
      await assertEscrowEmpty(tx, contest, to);
      return;
    case 'settled': {
      await assertEscrowEmpty(tx, contest, to);
      const [placed] = await tx.select({ n: count() }).from(contestResults).where(eq(contestResults.contestId, contest.id));
      const expected = await activeCount(tx, contest.id);
      if ((placed?.n ?? 0) !== expected) {
        throw new ContestError('results_incomplete', `Contest ${contest.id} has results for ${placed?.n ?? 0} of ${expected} entrants`, {
          contestId: contest.id,
          results: placed?.n ?? 0,
          entrants: expected,
        });
      }
      return;
    }
    case 'draft':
    case 'open':
    case 'locked':
    case 'in_progress':
    case 'awaiting_settlement':
    case 'settling':
      return;
  }
}

async function activeCount(tx: DbOrTx, contestId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(contestParticipants)
    .where(and(eq(contestParticipants.contestId, contestId), inArray(contestParticipants.state, ['entered', 'disqualified'])));
  return row?.n ?? 0;
}

async function assertEscrowEmpty(tx: DbOrTx, contest: Contest, to: ContestState): Promise<void> {
  const balance = await balanceOf(tx, contest.escrowAccountId);
  if (balance !== 0n) {
    throw new ContestError('escrow_not_empty', `Contest ${contest.id} still holds ${balance} ${contest.asset} in escrow and cannot become ${to}`, {
      contestId: contest.id,
      balance: balance.toString(),
      to,
    });
  }
}
