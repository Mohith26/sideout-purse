import type { Asset, ContestKind, EligibilityDecision, EligibilityReason, RequiredAction, RestrictionKind, VerificationState } from '@purse/types';

import type { Ruleset } from './ruleset';

/**
 * The eligibility evaluator (spec 4.5): a pure function over the documented input and a
 * versioned ruleset, returning the sealed decision. No database, no clock, no randomness
 * may be imported here; `asOf` is an input because a pure function has no clock, and it is
 * the one field added to the spec's input shape (a user's age and a restriction's window
 * both need an instant to be judged against). `test/eligibility/evaluate.test.ts` is the
 * case table.
 *
 * Every applicable reason is reported, in a fixed priority order, and the required action
 * is the first reason's: a terminal reason (a block, a self-exclusion, a rejected identity,
 * an under-age user) has none, so a partner never shows "add funds" to someone who could
 * not enter with any amount of funds.
 */
export type RestrictionInput = {
  kind: RestrictionKind;
  /** ISO 8601 instants. */
  startsAt: string;
  endsAt: string | null;
  liftedAt?: string | null;
};

export type EvaluateInput = {
  user: {
    /** `YYYY-MM-DD`, or `null` when the partner has not supplied one. */
    dateOfBirth: string | null;
    verificationState: VerificationState;
    /** When set on a `verified` user and already past at `asOf`, the user counts as unverified until they verify again. */
    reverifyAfter?: string | null;
    restrictions: readonly RestrictionInput[];
    /** ISO 3166 code (`US-TX`) or `null` when unknown. */
    region: string | null;
  };
  contest: { asset: Asset; entryAmount: bigint; kind: ContestKind };
  wallet: { balance: bigint };
  /** Gross stakes escrowed by this user in the contest's asset over the rolling windows (spec 4.6), from the journal. */
  velocity: { enteredLast24h: bigint; enteredLast7d: bigint };
  ruleset: Ruleset;
  /** The instant the decision is made, ISO 8601. */
  asOf: string;
};

/** Reasons in the order they are reported; the first one's action is the decision's. */
export const REASON_PRIORITY: readonly EligibilityReason[] = [
  'platform_blocked',
  'self_excluded',
  'cooling_off',
  'identity_rejected',
  'under_minimum_age',
  'region_not_permitted',
  'region_unknown',
  'identity_unverified',
  'insufficient_balance',
  'stake_limit_exceeded',
  'velocity_limit_exceeded',
  'contest_not_open',
  'contest_full',
];

const RESTRICTION_REASON: Readonly<Record<RestrictionKind, EligibilityReason>> = {
  platform_block: 'platform_blocked',
  self_exclusion: 'self_excluded',
  cool_off: 'cooling_off',
  velocity_lock: 'velocity_limit_exceeded',
};

export function evaluate(input: EvaluateInput): EligibilityDecision {
  const { user, contest, wallet, velocity, ruleset } = input;
  const asOf = parseInstant(input.asOf, 'asOf');
  const found = new Set<EligibilityReason>();
  let unverifiedAction: RequiredAction = 'complete_identity';

  // Restrictions in force now (spec 4.6: honoured before every entry).
  for (const restriction of user.restrictions) {
    if (isActive(restriction, asOf)) found.add(RESTRICTION_REASON[restriction.kind]);
  }

  // Region. A list of permitted regions cannot be satisfied by an unknown region, and a
  // ruleset may require a known region even where every region is permitted.
  const permitted = ruleset.permittedRegions[contest.asset];
  if (user.region === null) {
    if (ruleset.requireKnownRegion[contest.asset] || permitted !== 'ALL') found.add('region_unknown');
  } else if (permitted !== 'ALL' && !regionPermitted(user.region, permitted)) {
    found.add('region_not_permitted');
  }

  // Age. Judged whenever the date of birth is known; an unknown one is refused only where
  // identity is required (below), since verification is what establishes it.
  const age = user.dateOfBirth === null ? null : ageOn(user.dateOfBirth, asOf);
  if (age !== null && age < minimumAge(ruleset, user.region)) found.add('under_minimum_age');

  // Identity. Required above the asset's threshold; a rejected identity is terminal.
  const threshold = ruleset.requireVerificationAbove[contest.asset];
  if (threshold !== null && contest.entryAmount > BigInt(threshold)) {
    if (user.verificationState === 'rejected') {
      found.add('identity_rejected');
    } else if (user.verificationState !== 'verified' || reverifyDue(user.reverifyAfter, asOf)) {
      found.add('identity_unverified');
      if (user.dateOfBirth === null) unverifiedAction = 'provide_demographics';
    }
  }

  // Funds and limits. Limits count the entry being attempted.
  if (wallet.balance < contest.entryAmount) found.add('insufficient_balance');
  const { perContest, per24h, per7d } = ruleset.stakeLimits;
  if (perContest !== null && contest.entryAmount > BigInt(perContest)) found.add('stake_limit_exceeded');
  if ((per24h !== null && velocity.enteredLast24h + contest.entryAmount > BigInt(per24h)) || (per7d !== null && velocity.enteredLast7d + contest.entryAmount > BigInt(per7d))) {
    found.add('velocity_limit_exceeded');
  }

  if (found.size === 0) return { allowed: true, rulesetVersion: ruleset.version };

  const reasons = REASON_PRIORITY.filter((reason) => found.has(reason));
  const first = reasons[0];
  const requiredAction = first === 'region_unknown' ? 'confirm_location' : first === 'identity_unverified' ? unverifiedAction : first === 'insufficient_balance' ? 'add_funds' : undefined;
  return {
    allowed: false,
    rulesetVersion: ruleset.version,
    reasons,
    ...(requiredAction === undefined ? {} : { requiredAction }),
  };
}

/** A restriction is in force from `startsAt` until `endsAt` (or forever) unless lifted. */
export function isActive(restriction: RestrictionInput, asOf: Date): boolean {
  if (restriction.liftedAt !== undefined && restriction.liftedAt !== null) return false;
  const starts = parseInstant(restriction.startsAt, 'startsAt');
  if (starts.getTime() > asOf.getTime()) return false;
  if (restriction.endsAt === null) return true;
  return parseInstant(restriction.endsAt, 'endsAt').getTime() > asOf.getTime();
}

/** The minimum age for a region: the region's own entry, then its country's, then the default. */
export function minimumAge(ruleset: Ruleset, region: string | null): number {
  if (region !== null) {
    const exact = ruleset.minimumAge.byRegion[region];
    if (exact !== undefined) return exact;
    const country = ruleset.minimumAge.byRegion[countryOf(region)];
    if (country !== undefined) return country;
  }
  return ruleset.minimumAge.default;
}

/** A region is permitted when it, or the country it belongs to, is listed. A bare country never satisfies a subdivision entry. */
export function regionPermitted(region: string, permitted: readonly string[]): boolean {
  return permitted.includes(region) || permitted.includes(countryOf(region));
}

function countryOf(region: string): string {
  return region.slice(0, 2);
}

/**
 * Whole years between a `YYYY-MM-DD` date of birth and an instant, on the UTC calendar.
 * Deterministic: the same two inputs always give the same age, whatever the process's zone.
 */
export function ageOn(dateOfBirth: string, asOf: Date): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (match === null) throw new RangeError(`dateOfBirth must be YYYY-MM-DD, got ${dateOfBirth}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let age = asOf.getUTCFullYear() - year;
  const birthdayPassed = asOf.getUTCMonth() + 1 > month || (asOf.getUTCMonth() + 1 === month && asOf.getUTCDate() >= day);
  if (!birthdayPassed) age -= 1;
  return age;
}

function reverifyDue(reverifyAfter: string | null | undefined, asOf: Date): boolean {
  if (reverifyAfter === undefined || reverifyAfter === null) return false;
  return parseInstant(reverifyAfter, 'reverifyAfter').getTime() <= asOf.getTime();
}

function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`${field} must be an ISO 8601 instant, got ${value}`);
  return parsed;
}
