import { describe, expect, it } from 'vitest';
import { ELIGIBILITY_REASONS, type EligibilityDecision, type EligibilityReason, type RequiredAction } from '@purse/types';

import { ageOn, evaluate, minimumAge, REASON_PRIORITY, regionPermitted, type EvaluateInput } from '../../src/eligibility/evaluate';
import { SPEC_EXAMPLE_RULESET, type Ruleset } from '../../src/eligibility/ruleset';

/**
 * Spec 4.5: the evaluator as a case table over the spec's own example ruleset, in the
 * spec's own asymmetry. POINTS is permitted everywhere with no verification; CREDIT is
 * region-gated, verification-gated and stake-limited. Each reason maps to its required
 * action, and a terminal reason has none.
 */
const NOW = '2026-09-18T12:00:00.000Z';
const ruleset: Ruleset = SPEC_EXAMPLE_RULESET;

type Case = {
  name: string;
  input: Partial<{
    user: Partial<EvaluateInput['user']>;
    contest: Partial<EvaluateInput['contest']>;
    wallet: Partial<EvaluateInput['wallet']>;
    velocity: Partial<EvaluateInput['velocity']>;
    ruleset: Ruleset;
    asOf: string;
  }>;
  expect: { allowed: true } | { allowed: false; reasons: EligibilityReason[]; requiredAction?: RequiredAction };
};

/** A user who passes everything for CREDIT: 32, verified, in Texas, funded, with no history. */
function base(): EvaluateInput {
  return {
    user: { dateOfBirth: '1994-03-12', verificationState: 'verified', reverifyAfter: '2027-01-01T00:00:00.000Z', restrictions: [], region: 'US-TX' },
    contest: { asset: 'CREDIT', entryAmount: 1_000n, kind: 'tournament' },
    wallet: { balance: 5_000n },
    velocity: { enteredLast24h: 0n, enteredLast7d: 0n },
    ruleset,
    asOf: NOW,
  };
}

function build(partial: Case['input']): EvaluateInput {
  const b = base();
  return {
    user: { ...b.user, ...partial.user },
    contest: { ...b.contest, ...partial.contest },
    wallet: { ...b.wallet, ...partial.wallet },
    velocity: { ...b.velocity, ...partial.velocity },
    ruleset: partial.ruleset ?? b.ruleset,
    asOf: partial.asOf ?? b.asOf,
  };
}

const active = (kind: 'self_exclusion' | 'cool_off' | 'platform_block' | 'velocity_lock', endsAt: string | null = null) => ({
  kind,
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt,
});

const CASES: Case[] = [
  // The asymmetry: POINTS everywhere, for anyone with a funded wallet.
  { name: 'POINTS: an unverified user with no date of birth and no region is allowed', input: { contest: { asset: 'POINTS', entryAmount: 100n }, user: { verificationState: 'unstarted', dateOfBirth: null, region: null } }, expect: { allowed: true } },
  { name: 'POINTS: a user in a region CREDIT does not permit is allowed', input: { contest: { asset: 'POINTS' }, user: { region: 'US-NY', verificationState: 'unstarted' } }, expect: { allowed: true } },
  { name: 'POINTS: a rejected identity is still allowed, since no verification is required', input: { contest: { asset: 'POINTS' }, user: { verificationState: 'rejected' } }, expect: { allowed: true } },
  { name: 'CREDIT: the fully eligible user is allowed', input: {}, expect: { allowed: true } },

  // CREDIT is verification-gated and region-gated.
  { name: 'CREDIT: unverified with demographics needs to complete identity', input: { user: { verificationState: 'unstarted' } }, expect: { allowed: false, reasons: ['identity_unverified'], requiredAction: 'complete_identity' } },
  { name: 'CREDIT: unverified without a date of birth needs demographics first', input: { user: { verificationState: 'unstarted', dateOfBirth: null } }, expect: { allowed: false, reasons: ['identity_unverified'], requiredAction: 'provide_demographics' } },
  { name: 'CREDIT: pending counts as unverified', input: { user: { verificationState: 'pending' } }, expect: { allowed: false, reasons: ['identity_unverified'], requiredAction: 'complete_identity' } },
  { name: 'CREDIT: a verification due for renewal counts as unverified', input: { user: { reverifyAfter: '2026-09-18T11:59:59.000Z' } }, expect: { allowed: false, reasons: ['identity_unverified'], requiredAction: 'complete_identity' } },
  { name: 'CREDIT: a verification renewing later today is still good', input: { user: { reverifyAfter: '2026-09-18T12:00:01.000Z' } }, expect: { allowed: true } },
  { name: 'CREDIT: a rejected identity is terminal, with no action', input: { user: { verificationState: 'rejected' } }, expect: { allowed: false, reasons: ['identity_rejected'] } },
  { name: 'CREDIT: an unknown region must be confirmed', input: { user: { region: null } }, expect: { allowed: false, reasons: ['region_unknown'], requiredAction: 'confirm_location' } },
  { name: 'CREDIT: a region outside the permitted list is refused with no action', input: { user: { region: 'US-NY' } }, expect: { allowed: false, reasons: ['region_not_permitted'] } },
  { name: 'CREDIT: a bare country does not satisfy a subdivision list', input: { user: { region: 'US' } }, expect: { allowed: false, reasons: ['region_not_permitted'] } },
  { name: 'CREDIT: every permitted region is permitted', input: { user: { region: 'US-NC' } }, expect: { allowed: true } },

  // Age, by region.
  { name: 'under the default minimum age', input: { user: { dateOfBirth: '2009-01-01' } }, expect: { allowed: false, reasons: ['under_minimum_age'] } },
  { name: 'exactly 18 today is of age by default', input: { user: { dateOfBirth: '2008-09-18' } }, expect: { allowed: true } },
  { name: 'turning 18 tomorrow is under age today', input: { user: { dateOfBirth: '2008-09-19' } }, expect: { allowed: false, reasons: ['under_minimum_age'] } },
  { name: 'a region with a higher minimum age applies it: 20 in Massachusetts is under 21', input: { contest: { asset: 'POINTS' }, user: { region: 'US-MA', dateOfBirth: '2006-01-01' } }, expect: { allowed: false, reasons: ['under_minimum_age'] } },
  { name: 'the same 20-year-old is of age in Texas', input: { contest: { asset: 'POINTS' }, user: { region: 'US-TX', dateOfBirth: '2006-01-01' } }, expect: { allowed: true } },
  { name: 'POINTS with a known under-age date of birth is refused even though POINTS needs no verification', input: { contest: { asset: 'POINTS' }, user: { dateOfBirth: '2012-05-05', verificationState: 'unstarted', region: null } }, expect: { allowed: false, reasons: ['under_minimum_age'] } },

  // Restrictions, honoured before every entry.
  { name: 'self-excluded, with no end, is refused with no action', input: { contest: { asset: 'POINTS' }, user: { restrictions: [active('self_exclusion')] } }, expect: { allowed: false, reasons: ['self_excluded'] } },
  { name: 'cooling off until later is refused', input: { contest: { asset: 'POINTS' }, user: { restrictions: [active('cool_off', '2026-09-19T00:00:00.000Z')] } }, expect: { allowed: false, reasons: ['cooling_off'] } },
  { name: 'a cool-off that has ended no longer applies', input: { contest: { asset: 'POINTS' }, user: { restrictions: [active('cool_off', '2026-09-18T11:00:00.000Z')] } }, expect: { allowed: true } },
  { name: 'a restriction that has not started yet does not apply', input: { contest: { asset: 'POINTS' }, user: { restrictions: [{ kind: 'self_exclusion', startsAt: '2026-10-01T00:00:00.000Z', endsAt: null }] } }, expect: { allowed: true } },
  { name: 'a lifted restriction does not apply', input: { contest: { asset: 'POINTS' }, user: { restrictions: [{ ...active('platform_block'), liftedAt: '2026-09-10T00:00:00.000Z' }] } }, expect: { allowed: true } },
  { name: 'platform blocked is refused with no action', input: { contest: { asset: 'POINTS' }, user: { restrictions: [active('platform_block')] } }, expect: { allowed: false, reasons: ['platform_blocked'] } },
  { name: 'a velocity lock reads as the velocity limit', input: { contest: { asset: 'POINTS' }, user: { restrictions: [active('velocity_lock', '2026-09-19T00:00:00.000Z')] } }, expect: { allowed: false, reasons: ['velocity_limit_exceeded'] } },

  // Funds and limits, counting the entry being attempted.
  { name: 'insufficient balance asks for funds', input: { wallet: { balance: 999n } }, expect: { allowed: false, reasons: ['insufficient_balance'], requiredAction: 'add_funds' } },
  { name: 'a balance equal to the entry is enough', input: { wallet: { balance: 1_000n } }, expect: { allowed: true } },
  { name: 'an entry above the per-contest stake limit', input: { contest: { entryAmount: 50_001n }, wallet: { balance: 100_000n } }, expect: { allowed: false, reasons: ['stake_limit_exceeded'] } },
  { name: 'an entry at the per-contest stake limit is allowed', input: { contest: { entryAmount: 50_000n }, wallet: { balance: 100_000n } }, expect: { allowed: true } },
  { name: 'the 24-hour velocity limit counts this entry', input: { velocity: { enteredLast24h: 199_001n, enteredLast7d: 199_001n } }, expect: { allowed: false, reasons: ['velocity_limit_exceeded'] } },
  { name: 'exactly the 24-hour limit is allowed', input: { velocity: { enteredLast24h: 199_000n, enteredLast7d: 199_000n } }, expect: { allowed: true } },
  { name: 'the 7-day velocity limit', input: { velocity: { enteredLast24h: 0n, enteredLast7d: 999_500n } }, expect: { allowed: false, reasons: ['velocity_limit_exceeded'] } },

  // Several reasons at once: all reported in priority order, the first one's action taken.
  {
    name: 'a blocked, unverified, unfunded user in an unknown region: every reason, no action',
    input: { user: { restrictions: [active('platform_block')], verificationState: 'unstarted', region: null }, wallet: { balance: 0n } },
    expect: { allowed: false, reasons: ['platform_blocked', 'region_unknown', 'identity_unverified', 'insufficient_balance'] },
  },
  {
    name: 'unknown region and unverified: confirm the location first',
    input: { user: { verificationState: 'unstarted', region: null } },
    expect: { allowed: false, reasons: ['region_unknown', 'identity_unverified'], requiredAction: 'confirm_location' },
  },
  {
    name: 'unverified and unfunded: identity first',
    input: { user: { verificationState: 'unstarted' }, wallet: { balance: 0n } },
    expect: { allowed: false, reasons: ['identity_unverified', 'insufficient_balance'], requiredAction: 'complete_identity' },
  },
  {
    name: 'under age and unfunded: no action, the age is terminal',
    input: { user: { dateOfBirth: '2015-01-01' }, wallet: { balance: 0n } },
    expect: { allowed: false, reasons: ['under_minimum_age', 'insufficient_balance'] },
  },
];

describe('evaluate(): the spec 4.5 case table', () => {
  for (const each of CASES) {
    it(each.name, () => {
      const decision = evaluate(build(each.input));
      const expected: EligibilityDecision = each.expect.allowed
        ? { allowed: true, rulesetVersion: ruleset.version }
        : { allowed: false, rulesetVersion: ruleset.version, reasons: each.expect.reasons, ...(each.expect.requiredAction === undefined ? {} : { requiredAction: each.expect.requiredAction }) };
      expect(decision).toEqual(expected);
    });
  }

  it('reports reasons in a fixed order that covers the whole sealed vocabulary', () => {
    expect([...REASON_PRIORITY].sort()).toEqual([...ELIGIBILITY_REASONS].sort());
    expect(new Set(REASON_PRIORITY).size).toBe(ELIGIBILITY_REASONS.length);
  });

  it('is pure: the same input decides the same, and the input is not touched', () => {
    const input = build({ user: { verificationState: 'unstarted', region: null }, wallet: { balance: 0n } });
    const snapshot = JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    const first = evaluate(input);
    const second = evaluate(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshot);
  });

  it('a ruleset with no limits and no gates allows everyone with funds', () => {
    const open: Ruleset = {
      ...ruleset,
      version: '2026.09.2',
      permittedRegions: { POINTS: 'ALL', CREDIT: 'ALL' },
      stakeLimits: { perContest: null, per24h: null, per7d: null },
      requireVerificationAbove: { POINTS: null, CREDIT: null },
      requireKnownRegion: { POINTS: false, CREDIT: false },
    };
    const decision = evaluate(build({ ruleset: open, user: { verificationState: 'rejected', region: null, dateOfBirth: null }, contest: { entryAmount: 10_000_000n }, wallet: { balance: 10_000_000n }, velocity: { enteredLast24h: 10n ** 12n, enteredLast7d: 10n ** 13n } }));
    expect(decision).toEqual({ allowed: true, rulesetVersion: '2026.09.2' });
  });

  it('a verification threshold applies strictly above the amount', () => {
    const thresholds: Ruleset = { ...ruleset, requireVerificationAbove: { POINTS: 500, CREDIT: 0 } };
    expect(evaluate(build({ ruleset: thresholds, contest: { asset: 'POINTS', entryAmount: 500n }, user: { verificationState: 'unstarted' } }))).toMatchObject({ allowed: true });
    expect(evaluate(build({ ruleset: thresholds, contest: { asset: 'POINTS', entryAmount: 501n }, user: { verificationState: 'unstarted' } }))).toMatchObject({ allowed: false, reasons: ['identity_unverified'] });
  });

  it('refuses malformed instants and dates loudly rather than deciding on them', () => {
    expect(() => evaluate(build({ asOf: 'yesterday' }))).toThrow(RangeError);
    expect(() => evaluate(build({ user: { dateOfBirth: '12/03/1994' } }))).toThrow(RangeError);
    expect(() => evaluate(build({ user: { restrictions: [{ kind: 'cool_off', startsAt: 'soon', endsAt: null }] } }))).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('ageOn counts whole years on the UTC calendar', () => {
    const asOf = new Date('2026-09-18T00:00:00.000Z');
    expect(ageOn('1994-03-12', asOf)).toBe(32);
    expect(ageOn('2008-09-18', asOf)).toBe(18);
    expect(ageOn('2008-09-19', asOf)).toBe(17);
    expect(ageOn('2008-02-29', new Date('2026-02-28T23:59:59.000Z'))).toBe(17);
    expect(ageOn('2008-02-29', new Date('2026-03-01T00:00:00.000Z'))).toBe(18);
  });

  it('minimumAge falls back from the region to its country to the default', () => {
    const withCountry: Ruleset = { ...ruleset, minimumAge: { default: 18, byRegion: { US: 19, 'US-IA': 21 } } };
    expect(minimumAge(withCountry, 'US-IA')).toBe(21);
    expect(minimumAge(withCountry, 'US-TX')).toBe(19);
    expect(minimumAge(withCountry, 'GB')).toBe(18);
    expect(minimumAge(withCountry, null)).toBe(18);
    expect(minimumAge(ruleset, 'US-NE')).toBe(19);
  });

  it('regionPermitted accepts a listed region or its listed country, never a bare country for a listed subdivision', () => {
    expect(regionPermitted('US-TX', ['US-TX'])).toBe(true);
    expect(regionPermitted('US-TX', ['US'])).toBe(true);
    expect(regionPermitted('US', ['US-TX'])).toBe(false);
    expect(regionPermitted('CA-ON', ['US'])).toBe(false);
  });
});
