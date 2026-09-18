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

/** The refusal an entry reports: `not_eligible` with the sealed reasons and required action in its detail (spec 4.7). */
export function notEligible(contest: Contest, userId: string, decision: EligibilityDecision & { allowed: false }): ContestError {
  return new ContestError('not_eligible', `User ${userId} is not eligible to enter contest ${contest.id}: ${decision.reasons.join(', ')}`, {
    contestId: contest.id,
    userId,
    reasons: decision.reasons,
    ...(decision.requiredAction === undefined ? {} : { requiredAction: decision.requiredAction }),
    rulesetVersion: decision.rulesetVersion,
  });
}
