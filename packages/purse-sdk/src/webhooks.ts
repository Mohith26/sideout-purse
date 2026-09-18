import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from '@purse/types';

/**
 * The webhook signature (spec 4.9), one implementation for both sides: Purse's dispatcher
 * signs with `signWebhook`, and a partner's receiver checks with `verifyWebhook`. The
 * header is `Purse-Signature: t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256 over
 * `"{t}.{rawBody}"` with the endpoint's signing secret. The raw body is what was sent on
 * the wire; a receiver must verify the bytes it received, never a re-serialised object.
 *
 * Web Crypto only, so the same code runs in Node, a worker and a browser. The comparison
 * is constant time in the length of the expected digest, and a timestamp further than
 * `toleranceSeconds` from the receiver's clock is refused as a replay whatever the
 * signature says. `v1` is the only scheme; a header may carry several `v1` entries (a
 * secret rotation signs with the old and the new for a while) and any one match is enough.
 */
export const SIGNATURE_SCHEME = 'v1';

export type SignedHeader = { timestamp: number; header: string; signature: string };

export type VerifyOptions = {
  /** The receiver's clock, in milliseconds since the epoch. Defaults to `Date.now()`. */
  now?: number;
  toleranceSeconds?: number;
};

export type VerifyFailure = 'malformed_header' | 'timestamp_out_of_window' | 'signature_mismatch';

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure };

const encoder = new TextEncoder();

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** True when the two strings are equal, taking time that depends only on `expected`'s length. */
export function constantTimeEqual(expected: string, given: string): boolean {
  const a = encoder.encode(expected);
  const b = encoder.encode(given);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i % Math.max(b.length, 1)] ?? 0);
  return diff === 0;
}

/** Sign a raw body at `timestamp` (unix seconds). Purse's dispatcher uses this; a test receiver may too. */
export async function signWebhook(rawBody: string, secret: string, timestamp: number): Promise<SignedHeader> {
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new RangeError('timestamp must be unix seconds');
  const signature = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return { timestamp, signature, header: `t=${timestamp},${SIGNATURE_SCHEME}=${signature}` };
}

export type ParsedSignature = { timestamp: number; signatures: string[] };

export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | undefined {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return undefined;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) return undefined;
      timestamp = Number(value);
    } else if (name === SIGNATURE_SCHEME) {
      if (!/^[0-9a-f]{64}$/.test(value)) return undefined;
      signatures.push(value);
    }
    // Unknown schemes are ignored so a future `v2` does not break a `v1` receiver.
  }
  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

/**
 * Verify a received webhook. `rawBody` is the exact request body text; `header` is the
 * `Purse-Signature` value; `secret` is the endpoint's signing secret.
 */
export async function verifyWebhook(rawBody: string, header: string | null | undefined, secret: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const parsed = parseSignatureHeader(header);
  if (parsed === undefined) return { ok: false, reason: 'malformed_header' };
  const tolerance = options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) return { ok: false, reason: 'timestamp_out_of_window' };
  const expected = await hmacHex(secret, `${parsed.timestamp}.${rawBody}`);
  // Every candidate is compared so the time taken does not say which one was close.
  let matched = false;
  for (const candidate of parsed.signatures) matched = constantTimeEqual(expected, candidate) || matched;
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: 'signature_mismatch' };
}
