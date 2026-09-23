import type { PaymentDirection, PaymentState } from '../db/schema';
import { TreasuryError } from './errors';

/**
 * The payment state machine (spec 13.2), as data.
 *
 * Two machines share one table because they share one audit trail, one set of invariants
 * and one operator queue. They do not share transitions, and this is the only place that
 * says which moves exist. The database holds the weaker version of the same rule (a
 * direction may only ever hold its own states, and a terminal payment cannot move at all);
 * this holds the exact one.
 *
 *   deposit     requires_action -> authorized -> captured -> settled
 *                     |               |             |
 *                     +---------------+------> failed / cancelled
 *                                           captured -> refunded
 *
 *   withdrawal  requested -> in_review -> approved -> paid
 *                    |           |           |
 *                    +-----------+-----> failed / cancelled
 *                                        approved -> returned
 *
 * The asymmetry is real and worth keeping: a deposit is authorized then captured because
 * that is what a card does, and a withdrawal goes through review because pushing money out
 * is the direction fraud cares about.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentDirection, Readonly<Record<PaymentState, readonly PaymentState[]>>>> = {
  deposit: {
    requires_action: ['authorized', 'failed', 'cancelled'],
    authorized: ['captured', 'failed', 'cancelled'],
    captured: ['settled', 'refunded'],
    settled: [],
    refunded: [],
    failed: [],
    cancelled: [],
    // Unreachable for a deposit; listed so the record is total.
    requested: [],
    in_review: [],
    approved: [],
    paid: [],
    returned: [],
  },
  withdrawal: {
    requested: ['in_review', 'approved', 'failed', 'cancelled'],
    in_review: ['approved', 'failed', 'cancelled'],
    approved: ['paid', 'returned'],
    paid: [],
    returned: [],
    failed: [],
    cancelled: [],
    // Unreachable for a withdrawal.
    requires_action: [],
    authorized: [],
    captured: [],
    settled: [],
    refunded: [],
  },
};

/** Where each direction's machine starts. */
export const INITIAL_STATE: Readonly<Record<PaymentDirection, PaymentState>> = {
  deposit: 'requires_action',
  withdrawal: 'requested',
};

export function canTransition(direction: PaymentDirection, from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[direction][from].includes(to);
}

/** Refuse a move the machine does not define, naming what would have been allowed. */
export function assertTransition(direction: PaymentDirection, from: PaymentState, to: PaymentState): void {
  if (canTransition(direction, from, to)) return;
  const allowed = PAYMENT_TRANSITIONS[direction][from];
  throw new TreasuryError(
    allowed.length === 0 ? 'payment_terminal' : 'invalid_transition',
    allowed.length === 0
      ? `A ${direction} in ${from} is finished and cannot move to ${to}`
      : `A ${direction} cannot move from ${from} to ${to}; allowed: ${allowed.join(', ')}`,
    { direction, from, to, allowed: allowed.join(',') },
  );
}
