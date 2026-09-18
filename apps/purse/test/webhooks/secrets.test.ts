import { describe, expect, it } from 'vitest';

import { decryptSecret, deriveKey, deriveProcessKeys, encryptSecret, ENVELOPE_PREFIX, SecretEnvelopeError } from '../../src/secrets';

/**
 * Signing secrets rest under AES-256-GCM (docs/decisions.md, phase 4): a key derived from
 * the process secret per purpose, a fresh IV per envelope, and the endpoint id bound as
 * associated data so an envelope cannot be moved between endpoints.
 */
describe('secrets', () => {
  const keys = deriveProcessKeys('a-test-secret-key-of-at-least-thirty-two-characters');

  it('derives a distinct 32-byte key per purpose and the same key for the same input', () => {
    expect(keys['webhook-secrets']).toHaveLength(32);
    expect(keys['embed-session'].equals(keys['signin-code'])).toBe(false);
    expect(keys['embed-session'].equals(keys['webhook-secrets'])).toBe(false);
    expect(deriveKey('a-test-secret-key-of-at-least-thirty-two-characters', 'embed-session').equals(keys['embed-session'])).toBe(true);
    expect(deriveKey('another-secret-key-of-at-least-thirty-two-chars', 'embed-session').equals(keys['embed-session'])).toBe(false);
  });

  it('round-trips, never repeats an envelope, and refuses the wrong key or the wrong endpoint', () => {
    const key = keys['webhook-secrets'];
    const a = encryptSecret(key, 'whsec_abc', 'whe_1');
    const b = encryptSecret(key, 'whsec_abc', 'whe_1');
    expect(a.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('whsec');
    expect(decryptSecret(key, a, 'whe_1')).toBe('whsec_abc');
    expect(decryptSecret(key, b, 'whe_1')).toBe('whsec_abc');
    expect(() => decryptSecret(key, a, 'whe_2')).toThrow(SecretEnvelopeError);
    expect(() => decryptSecret(keys['embed-session'], a, 'whe_1')).toThrow(SecretEnvelopeError);
    const [prefix, iv, tag, ciphertext] = [a.slice(0, ENVELOPE_PREFIX.length), ...a.slice(ENVELOPE_PREFIX.length).split(':')];
    expect(() => decryptSecret(key, `${prefix}${iv}:${tag}:${(ciphertext ?? '').replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'))}`, 'whe_1')).toThrow(SecretEnvelopeError);
    expect(() => decryptSecret(key, 'whsec_plain', 'whe_1')).toThrow(SecretEnvelopeError);
    expect(() => decryptSecret(key, `${ENVELOPE_PREFIX}x`, 'whe_1')).toThrow(SecretEnvelopeError);
  });
});
