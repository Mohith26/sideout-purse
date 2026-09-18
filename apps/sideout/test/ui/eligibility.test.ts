import { ELIGIBILITY_REASONS } from '@purse/types';
import { describe, expect, it } from 'vitest';

import { mapPurseError, TERMINAL_REASONS, verificationRowState } from '../../src/components/purse/eligibility';

/**
 * The sealed eligibility variants (spec 4.5) as UI states (spec 5.3, "Profile"): every
 * reason maps somewhere, a terminal reason gets no retry and a support path, a required
 * action names the one flow that resolves it, and both the SDK's raw error and a Sideout
 * route's wrapped refusal land on the same state.
 */
describe('mapPurseError', () => {
  it('maps every sealed reason to a state', () => {
    for (const reason of ELIGIBILITY_REASONS) {
      const state = mapPurseError({ type: 'not_eligible', code: 'x', message: 'm', detail: { reasons: [reason], rulesetVersion: '1' } });
      expect(['terminal', 'action', 'retry']).toContain(state.kind);
      if (state.kind !== 'unavailable') expect(state.reasons).toEqual([reason]);
      expect(state.title.length).toBeGreaterThan(0);
      expect(state.body.length).toBeGreaterThan(0);
    }
  });

  it('a terminal reason wins over an action, and never offers a retry', () => {
    for (const reason of TERMINAL_REASONS) {
      const state = mapPurseError({ type: 'not_eligible', code: 'x', message: 'm', detail: { reasons: [reason, 'insufficient_balance'], requiredAction: 'add_funds', rulesetVersion: '1' } });
      expect(state.kind).toBe('terminal');
    }
    expect(mapPurseError({ type: 'not_eligible', code: 'x', message: 'm', detail: { reasons: ['identity_rejected'], rulesetVersion: '1' } })).toMatchObject({ kind: 'terminal', title: 'Purse could not verify this account' });
  });

  it('a required action names the flow that resolves it', () => {
    expect(mapPurseError({ type: 'not_eligible', code: 'x', message: 'm', detail: { reasons: ['identity_unverified'], requiredAction: 'complete_identity', rulesetVersion: '1' } })).toMatchObject({ kind: 'action', flow: 'identity' });
    expect(mapPurseError({ type: 'not_eligible', code: 'x', message: 'm', detail: { reasons: ['insufficient_balance'], requiredAction: 'add_funds', rulesetVersion: '1' } })).toMatchObject({ kind: 'action', flow: 'wallet' });
    expect(mapPurseError({ type: 'not_eligible', code: 'x', message: 'm', detail: { reasons: ['region_unknown'], requiredAction: 'confirm_location', rulesetVersion: '1' } })).toMatchObject({ kind: 'retry' });
    expect(mapPurseError({ type: 'insufficient_funds', code: 'x', message: 'm' })).toMatchObject({ kind: 'action', flow: 'wallet' });
  });

  it('reads a refusal a Sideout route wrapped as detail.purse the same way as the SDK error', () => {
    const wrapped = mapPurseError({ type: 'invalid_state', code: 'not_eligible', message: 'm', detail: { purse: { type: 'not_eligible', code: 'not_eligible', message: 'm', detail: { reasons: ['platform_blocked'], rulesetVersion: '1' } } } });
    expect(wrapped).toMatchObject({ kind: 'terminal', reasons: ['platform_blocked'] });
  });

  it('classifies the other sealed types and anything unknown as unavailable', () => {
    expect(mapPurseError({ type: 'rate_limited', code: 'x', message: 'm' }).kind).toBe('retry');
    expect(mapPurseError({ type: 'authentication_error', code: 'x', message: 'm' }).kind).toBe('retry');
    expect(mapPurseError({ type: 'invalid_state', code: 'x', message: 'm' }).kind).toBe('retry');
    expect(mapPurseError({ type: 'internal_error', code: 'x', message: 'm' }).kind).toBe('unavailable');
    expect(mapPurseError({ type: 'bogus', code: 'x', message: 'm' }).kind).toBe('unavailable');
  });
});

describe('verificationRowState', () => {
  const verification = (state: 'unstarted' | 'pending' | 'verified' | 'rejected') => ({ state, provider: null, verifiedAt: null, reverifyAfter: null });
  it('follows the live verification state, with a platform block as the terminal restricted row', () => {
    expect(verificationRowState(false, null, [])).toBe('not_linked');
    expect(verificationRowState(true, verification('unstarted'), [])).toBe('unstarted');
    expect(verificationRowState(true, verification('verified'), [])).toBe('verified');
    expect(verificationRowState(true, verification('rejected'), [])).toBe('rejected');
    expect(verificationRowState(true, verification('verified'), [{ kind: 'platform_block' }])).toBe('restricted');
    expect(verificationRowState(true, verification('verified'), [{ kind: 'cool_off' }])).toBe('verified');
  });
});
