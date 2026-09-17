import { describe, expect, it } from 'vitest';

import {
  API_ERROR_STATUS,
  API_ERROR_TYPES,
  PROTOCOL_VERSION,
  REQUEST_ID_HEADER,
  isApiErrorEnvelope,
  isProtocolEnvelope,
  type ApiError,
} from '../src/index';

describe('error taxonomy', () => {
  it('maps every sealed type to an HTTP status', () => {
    for (const type of API_ERROR_TYPES) {
      expect(API_ERROR_STATUS[type]).toBeGreaterThanOrEqual(400);
      expect(API_ERROR_STATUS[type]).toBeLessThan(600);
    }
  });

  it('recognises an error envelope by its sealed type', () => {
    const notEligible: ApiError = {
      type: 'not_eligible',
      code: 'eligibility_denied',
      message: 'Not eligible',
      detail: { reasons: ['under_minimum_age'], rulesetVersion: '2026.09.1' },
    };
    expect(isApiErrorEnvelope({ error: notEligible })).toBe(true);
    expect(isApiErrorEnvelope({ data: { ok: true } })).toBe(false);
    expect(isApiErrorEnvelope({ error: { type: 'something_else', code: 'x', message: 'y' } })).toBe(false);
    expect(isApiErrorEnvelope(null)).toBe(false);
  });
});

describe('protocol envelope', () => {
  it('is version 1 from the first commit', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts only envelopes of this version', () => {
    expect(isProtocolEnvelope({ v: 1, type: 'handshake:init', nonce: null, payload: {} })).toBe(true);
    expect(isProtocolEnvelope({ v: 2, type: 'handshake:init', nonce: null, payload: {} })).toBe(false);
    expect(isProtocolEnvelope({ v: 1, type: 'x', nonce: 5, payload: {} })).toBe(false);
    expect(isProtocolEnvelope({ v: 1, type: 'x', nonce: 'n' })).toBe(false);
    expect(isProtocolEnvelope('nope')).toBe(false);
  });
});

describe('headers', () => {
  it('uses the canonical request id header spelling', () => {
    expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
  });
});
