import { describe, expect, it } from 'vitest';

import { API_ERROR_STATUS, API_ERROR_TYPES, REQUEST_ID_HEADER, isRequestId } from '../src/index';

describe('error taxonomy', () => {
  it('maps every sealed type to an HTTP status', () => {
    for (const type of API_ERROR_TYPES) {
      expect(API_ERROR_STATUS[type]).toBeGreaterThanOrEqual(400);
      expect(API_ERROR_STATUS[type]).toBeLessThan(600);
    }
  });
});

describe('headers', () => {
  it('uses the canonical request id header spelling', () => {
    expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
  });

  it('keeps only request ids both services agree on', () => {
    expect(isRequestId('sideout-req-0001')).toBe(true);
    expect(isRequestId(crypto.randomUUID())).toBe(true);
    expect(isRequestId('short')).toBe(false);
    expect(isRequestId('has spaces in it')).toBe(false);
    expect(isRequestId('x'.repeat(129))).toBe(false);
    expect(isRequestId(null)).toBe(false);
    expect(isRequestId(undefined)).toBe(false);
  });
});

describe('eligibility vocabulary', () => {
  it('is exactly the spec 4.5 list, in the spec order', async () => {
    const { ELIGIBILITY_REASONS, REQUIRED_ACTIONS, isEligibilityReason, isRequiredAction, isIdempotencyKey } = await import('../src/index');
    expect(ELIGIBILITY_REASONS).toEqual([
      'under_minimum_age',
      'region_not_permitted',
      'identity_unverified',
      'identity_rejected',
      'self_excluded',
      'cooling_off',
      'platform_blocked',
      'insufficient_balance',
      'stake_limit_exceeded',
      'velocity_limit_exceeded',
      'region_unknown',
      'contest_not_open',
      'contest_full',
    ]);
    expect(REQUIRED_ACTIONS).toEqual(['complete_identity', 'provide_demographics', 'add_funds', 'confirm_location']);
    expect(isEligibilityReason('self_excluded')).toBe(true);
    expect(isEligibilityReason('banned')).toBe(false);
    expect(isRequiredAction('add_funds')).toBe(true);
    expect(isRequiredAction('retry')).toBe(false);
    expect(isIdempotencyKey('order-123')).toBe(true);
    expect(isIdempotencyKey('has space')).toBe(false);
    expect(isIdempotencyKey('')).toBe(false);
    expect(isIdempotencyKey('k'.repeat(201))).toBe(false);
  });
});
