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
