import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Every key the process needs is derived from the one `PURSE_SECRET_KEY` with HKDF-SHA256
 * and a purpose label, so a secret used to sign sessions can never be the one that
 * encrypts webhook secrets, and rotating the process secret rotates them all. The three
 * purposes today: `embed-session` (the session cookie's HMAC), `signin-code` (the
 * one-time code HMAC) and `webhook-secrets` (the AES-256-GCM key an endpoint's signing
 * secret rests under; docs/decisions.md, phase 4).
 */
export const KEY_PURPOSES = ['embed-session', 'signin-code', 'webhook-secrets'] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

const KEY_BYTES = 32;

export function deriveKey(secretKey: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, 'purse:v1', purpose, KEY_BYTES));
}

/**
 * An encrypted secret at rest: `enc:v1:<iv>:<tag>:<ciphertext>`, each part base64url,
 * AES-256-GCM with a fresh 96-bit IV per encryption and the purpose bound as associated
 * data, so an envelope moved between columns or tables does not decrypt.
 */
export const ENVELOPE_PREFIX = 'enc:v1:';

export class SecretEnvelopeError extends Error {
  override readonly name = 'SecretEnvelopeError';
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptSecret(key: Buffer, envelope: string, aad: string): string {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) throw new SecretEnvelopeError('not an encrypted secret envelope');
  const parts = envelope.slice(ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) throw new SecretEnvelopeError('malformed secret envelope');
  const [ivText, tagText, ciphertextText] = parts as [string, string, string];
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new SecretEnvelopeError('malformed secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // A wrong key, a wrong purpose or a tampered envelope all fail the tag check; the cause is not for the caller.
    throw new SecretEnvelopeError('secret envelope failed authentication');
  }
}

/** The keys a running process holds, derived once at boot. */
export type ProcessKeys = Readonly<Record<KeyPurpose, Buffer>>;

export function deriveProcessKeys(secretKey: string): ProcessKeys {
  return { 'embed-session': deriveKey(secretKey, 'embed-session'), 'signin-code': deriveKey(secretKey, 'signin-code'), 'webhook-secrets': deriveKey(secretKey, 'webhook-secrets') };
}
