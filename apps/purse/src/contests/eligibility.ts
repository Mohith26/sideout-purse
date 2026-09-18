import type { EligibilityDecision } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { Contest } from '../db/schema';
import { decideEntry, rulesetForContest, type EntryDecision } from '../eligibility';
import type { GeoProvider, RiskProvider } from '../providers/types';
import { profileOf, resolveAndRecordLocation, type LocationInput } from '../users';
import type { User } from '../db/schema';
import type { Actor } from '../ledger/audit';
import { ContestError } from './errors';

/**
 * Where the eligibility engine (spec 4.5, `src/eligibility`) meets an entry. `enterContest`
 * calls this under the contest row lock and the per-user entry lock, after the contest's
 * own checks (`contest_not_open`, `contest_full`) and with the wallet balance in hand, so
 * the decision is made against the journal as it stands at that instant. What the partner
 * knows of the user's location goes through the `GeoProvider` seam first, and the
 * `RiskProvider` seam is consulted for signals alongside the pure evaluation.
 */
export type EntryEligibilityInput = {
  tenantId: Id<'tnt'>;
  user: User;
  contest: Contest;
  walletBalance: bigint;
  now: Date;
  location?: LocationInput | null;
  geo?: GeoProvider;
  risk?: RiskProvider;
  actor: Actor;
  requestId?: string;
};

export async function evaluateEntryEligibility(tx: DbOrTx, input: EntryEligibilityInput): Promise<EntryDecision> {
  if (input.location !== undefined && input.location !== null) {
    if (input.geo === undefined) throw new ContestError('invalid_input', 'a location was given but no geolocation provider is configured', { field: 'location' });
    await resolveAndRecordLocation(tx, { user: input.user, location: input.location, geo: input.geo, actor: input.actor, now: input.now, ...(input.requestId === undefined ? {} : { requestId: input.requestId }) });
  }
  const profile = await profileOf(tx, input.user, input.now);
  const ruleset = await rulesetForContest(tx, input.contest);
  return decideEntry(tx, {
    tenantId: input.tenantId,
    profile,
    contest: input.contest,
    walletBalance: input.walletBalance,
    ruleset,
    now: input.now,
    ...(input.risk === undefined ? {} : { risk: input.risk }),
  });
}

/**
 * The refusal an entry reports, with the sealed reasons and required action in its detail
 * (spec 4.7): `insufficient_funds` when a shortfall is the only thing in the way, the money
 * type a partner routes to funding; `not_eligible` for everything else, including a
 * shortfall alongside a compliance reason (docs/decisions.md).
 */
export function notEligible(contest: Contest, userId: string, decision: EligibilityDecision & { allowed: false }, walletBalance: bigint): ContestError {
  const detail = {
    contestId: contest.id,
    userId,
    reasons: decision.reasons,
    ...(decision.requiredAction === undefined ? {} : { requiredAction: decision.requiredAction }),
    rulesetVersion: decision.rulesetVersion,
  };
  if (decision.reasons.length === 1 && decision.reasons[0] === 'insufficient_balance') {
    return new ContestError('insufficient_funds', `User ${userId} holds ${walletBalance} ${contest.asset}; entering contest ${contest.id} takes ${contest.entryAmount}`, {
      ...detail,
      balance: walletBalance.toString(),
      requested: contest.entryAmount.toString(),
      shortfall: (contest.entryAmount - walletBalance).toString(),
    });
  }
  return new ContestError('not_eligible', `User ${userId} is not eligible to enter contest ${contest.id}: ${decision.reasons.join(', ')}`, detail);
}
