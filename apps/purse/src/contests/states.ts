import type { Contest, ContestState } from '../db/schema';
import type { Actor } from '../ledger/audit';
import { ContestError } from './errors';

/**
 * The spec 4.3 lifecycle as a table. `transition()` consults it and nothing else decides
 * where a contest may go; the database holds the same table in the
 * `contests_state_machine` trigger (`drizzle/0006_contest_guards.sql`) and
 * `test/contests/transition.test.ts` proves the two agree pair for pair.
 *
 *   draft -> open -> locked -> in_progress -> awaiting_settlement -> settling -> settled
 *
 * `cancelled` is reachable from every non-terminal state but `settling`, only while no
 * entry is held (its guard). `voided` is reachable once entries may exist, from `open`
 * through `awaiting_settlement`, and refunds every entry first. `settling` exists only
 * inside the settlement transaction: it is entered and left under one row lock, so a
 * second settlement of the same contest is impossible rather than merely unlikely.
 */
export const TRANSITIONS: Readonly<Record<ContestState, readonly ContestState[]>> = {
  draft: ['open', 'cancelled'],
  open: ['locked', 'cancelled', 'voided'],
  locked: ['in_progress', 'cancelled', 'voided'],
  in_progress: ['awaiting_settlement', 'cancelled', 'voided'],
  awaiting_settlement: ['settling', 'cancelled', 'voided'],
  settling: ['settled'],
  settled: [],
  cancelled: [],
  voided: [],
};

export const CONTEST_STATES = Object.keys(TRANSITIONS) as ContestState[];

export const TERMINAL_STATES: ReadonlySet<ContestState> = new Set<ContestState>(['settled', 'cancelled', 'voided']);

/** States in which a participant's stake may be sitting in escrow. */
export const ENTRY_HOLDING_STATES: ReadonlySet<ContestState> = new Set<ContestState>(['open', 'locked', 'in_progress', 'awaiting_settlement', 'settling']);

/** The audit action written for each arrival. Dotted, past tense where the state has one. */
export const TRANSITION_ACTIONS: Readonly<Record<ContestState, string>> = {
  draft: 'contest.created',
  open: 'contest.opened',
  locked: 'contest.locked',
  in_progress: 'contest.started',
  awaiting_settlement: 'contest.awaiting_settlement',
  settling: 'contest.settling',
  settled: 'contest.settled',
  cancelled: 'contest.cancelled',
  voided: 'contest.voided',
};

export function canTransition(from: ContestState, to: ContestState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The static half of a transition: the table, and who may drive it. A `user` actor never
 * moves a contest. Leaving `awaiting_settlement` under `operator_close` takes an operator
 * (spec 4.3 MUST), whatever the destination: settling, voiding and cancelling alike.
 */
export function assertTransition(contest: Pick<Contest, 'id' | 'state' | 'settlementPolicy'>, to: ContestState, actor: Actor): void {
  if (actor.kind === 'user') {
    throw new ContestError('actor_not_allowed', `A user cannot change a contest's state`, { contestId: contest.id, actorKind: actor.kind });
  }
  if (!canTransition(contest.state, to)) {
    throw new ContestError('invalid_transition', `Contest ${contest.id} is ${contest.state} and cannot move to ${to}`, {
      contestId: contest.id,
      from: contest.state,
      to,
      allowed: [...TRANSITIONS[contest.state]],
    });
  }
  if (contest.state === 'awaiting_settlement' && contest.settlementPolicy === 'operator_close' && actor.kind !== 'operator') {
    throw new ContestError(
      'operator_required',
      `Contest ${contest.id} settles on operator close; only an operator can move it out of awaiting_settlement`,
      { contestId: contest.id, from: contest.state, to, actorKind: actor.kind },
    );
  }
}
