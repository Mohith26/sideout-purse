import { describe, expect, it } from 'vitest';
import type { Id } from '@repo/ids';

import { issueSession, SESSION_TTL_SECONDS, verifySession } from '../../src/embed/session';
import { deriveProcessKeys } from '../../src/secrets';

/** The session cookie's signature, expiry and tenant binding, without a database. */
describe('embed session', () => {
  const keys = deriveProcessKeys('a-test-secret-key-of-at-least-thirty-two-characters');
  const otherKeys = deriveProcessKeys('another-secret-key-of-at-least-thirty-two-chars');
  const tenantId = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9' as Id<'tnt'>;
  const otherTenant = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845aa' as Id<'tnt'>;
  const now = new Date('2026-09-18T12:00:00.000Z');

  it('issues a token that verifies for its tenant until it expires', () => {
    const { token, expiresAt } = issueSession(keys, { tenantId, userId: 'usr_1', now });
    expect(expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_SECONDS * 1000);
    expect(verifySession(keys, token, tenantId, now)).toEqual({ tenantId, userId: 'usr_1', expiresAt });
    expect(verifySession(keys, token, tenantId, new Date(expiresAt.getTime() - 1))).toBeDefined();
    expect(verifySession(keys, token, tenantId, expiresAt)).toBeUndefined();
    expect(verifySession(keys, token, otherTenant, now)).toBeUndefined();
    expect(verifySession(otherKeys, token, tenantId, now)).toBeUndefined();
  });

  it('refuses anything malformed or tampered', () => {
    const { token } = issueSession(keys, { tenantId, userId: 'usr_1', now });
    const [payload, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, tid: tenantId, uid: 'usr_2', iat: 0, exp: 4_000_000_000 }), 'utf8').toString('base64url');
    for (const bad of [undefined, '', 'x', `${payload}.`, `.${signature}`, `${payload}.${signature.slice(0, -2)}zz`, `${forged}.${signature}`, `${payload}x.${signature}`, 'a'.repeat(3000)]) {
      expect(verifySession(keys, bad, tenantId, now), String(bad).slice(0, 20)).toBeUndefined();
    }
  });
});
