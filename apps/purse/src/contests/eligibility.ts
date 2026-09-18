import type { EligibilityDecision } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { Contest, User } from '../db/schema';
import { decideEntry, rulesetForContest, type EntryDecision, type Ruleset } from '../eligibility';
import type { RiskProvider } from '../providers/types';
import { profileOf } from '../users';
import { ContestError } from './errors';

/**
 * Where the eligibility engine (spec 4.5, `src/eligibility`) meets an entry. `enterContest`
 * calls this under the contest row lock and the per-user entry lock, after the contest's
 * own checks (`contest_not_open`, `contest_full`) and with the wallet balance in hand, so
 * the decision is made against the journal as it stands at that instant. The user's
 * location was recorded through the `GeoProvider` seam before the entry began (it is a
 * fact about the user, kept whether or not the entry goes through), and the `RiskProvider`
 * seam is consulted for signals alongside the pure evaluation.
 */
export type EntryEligibilityInput = {
  tenantId: Id<'tnt'>;
  user: User;
  contest: Contest;
  walletBalance: bigint;
  now: Date;
  risk?: RiskProvider;
};

export async function evaluateEntryEligibility(tx: DbOrTx, input: EntryEligibilityInput): Promise<EntryDecision> {
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
 * The version a refusal made before the evaluator ran (`contest_not_open`, `contest_full`)
 * reports: the one the contest pins, else the active one, as `rulesetForContest` judges.
 */
export async function rulesetVersionOf(db: DbOrTx, contest: Contest): Promise<string> {
  return contest.eligibilityRulesetVersion ?? (await rulesetForContest(db, contest)).version;
}

/**
 * A contest whose entry amount is above the per-contest stake limit of the ruleset its
 * entries are judged under could never be entered, so it is refused at creation and at
 * `open` as `invalid_request` rather than refusing every entrant `stake_limit_exceeded`.
 */
export function assertEntryAmountWithinLimit(contest: { entryAmount: bigint }, ruleset: Ruleset): void {
  const limit = ruleset.stakeLimits.perContest;
  if (limit === null || contest.entryAmount <= BigInt(limit)) return;
  throw new ContestError('entry_amount_above_stake_limit', `An entry of ${contest.entryAmount} is above the per-contest stake limit of ${limit} in ruleset ${ruleset.version}`, {
    field: 'entryAmount',
    entryAmount: contest.entryAmount.toString(),
    perContest: limit,
    rulesetVersion: ruleset.version,
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
