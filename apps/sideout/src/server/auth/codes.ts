import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * One-time sign-in codes. A code is six digits from `crypto.randomInt`, lives ten
 * minutes, allows five guesses, and is stored only as an HMAC keyed by the session
 * secret and bound to the phone it was issued for, so a leaked table gives an attacker
 * nothing to replay.
 */

export const CODE_LENGTH = 6;
export const CODE_TTL_SECONDS = 10 * 60;
export const CODE_MAX_ATTEMPTS = 5;

export function generateCode(random: (min: number, max: number) => number = randomInt): string {
  return String(random(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function codeKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('sideout:auth-code:v1').digest();
}

export function hashCode(code: string, phoneE164: string, secret: string): string {
  return createHmac('sha256', codeKey(secret)).update(`${phoneE164}:${code}`).digest('hex');
}

export function codeMatches(storedHash: string, candidate: string, phoneE164: string, secret: string): boolean {
  const given = Buffer.from(hashCode(candidate, phoneE164, secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}
