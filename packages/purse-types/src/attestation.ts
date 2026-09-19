import * as z from 'zod/mini';

/**
 * Signed score attestation (system spec section 12, item 1; decision D5 option C, additive
 * on top of A). A device the partner registered against a user signs the canonical form
 * of a score on-device with a non-extractable WebCrypto key; the partner verifies it, and
 * Purse verifies it again against its own copy of the public key when the score is
 * submitted, so a score can be proven to have been submitted by a registered device and
 * not forged in transit, by the partner, or by anyone between the two. This file is the
 * one definition of the canonical form, the key id, and the signature, shared by the
 * signing device, the partner's server and Purse (`docs/attestation.md` pins it).
 *
 * The canonical form is deliberately generic: the partner's own reference for what was
 * scored (`sourceRef`, the same value it submits with the score), any further bindings it
 * wants replay-proof (`refs`: a tournament, a team) and the content it scored (a
 * scoreline), all inside one JSON object with sorted keys and no whitespace, prefixed by
 * a domain string so the key can never be tricked into signing another protocol's JSON.
 * Purse checks the parts it can (the key, the signature, `sourceRef`, the timestamp) and
 * records the rest verbatim.
 *
 * Web Crypto only (`globalThis.crypto.subtle`), so the same code runs in a browser, a
 * worker and Node. ECDSA P-256 with SHA-256 (`ES256`), signatures in the raw `r || s` form
 * Web Crypto produces, base64url without padding.
 */
export const ATTESTATION_VERSION = 1;

/** The domain-separation prefix every signed byte string starts with. */
export const ATTESTATION_DOMAIN = 'purse-score-attestation/1\n';

export const ATTESTATION_ALGORITHMS = ['ES256'] as const;
export type AttestationAlgorithm = (typeof ATTESTATION_ALGORITHMS)[number];

/**
 * What Purse recorded about a score's attestation: `none` (the batch carried none for
 * that score), `verified` (a device registered to the attesting user, unrevoked, signed
 * exactly this content for exactly this `sourceRef`) or `unverified` (an attestation was
 * presented but Purse holds no device under that key id for that user, so it could not
 * be checked; the partner's own verification is all that vouches for it). An attestation
 * that fails a check Purse can make is refused, never recorded.
 */
export const ATTESTATION_STATES = ['none', 'verified', 'unverified'] as const;
export type AttestationState = (typeof ATTESTATION_STATES)[number];

/** Largest canonical byte string a device is expected to sign, and Purse to store. */
export const ATTESTATION_MAX_BYTES = 4096;

/** A strict instant: `YYYY-MM-DDTHH:mm:ss.sssZ`, the one spelling `Date#toISOString` produces. */
export const ATTESTATION_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---- Canonical JSON ----------------------------------------------------------------------

/** The value grammar the canonical form admits: JSON with integers only, so every implementation serialises it byte for byte the same. */
export type CanonicalValue = string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue };

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, strings as `JSON.stringify`
 * writes them, numbers as safe integers written in full. Refuses anything else (a float,
 * `undefined`, a bigint, a function) rather than guess.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON admits safe integers only, not ${String(value)}`);
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as CanonicalValue)}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

const canonicalValueSchema: z.ZodMiniType<CanonicalValue> = z.lazy(() =>
  z.union([z.string().check(z.maxLength(ATTESTATION_MAX_BYTES)), z.int(), z.boolean(), z.null(), z.array(canonicalValueSchema).check(z.maxLength(256)), z.record(z.string().check(z.maxLength(128)), canonicalValueSchema)]),
);

// ---- Keys ----------------------------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A P-256 public key as a JWK. Strict: a `d` (the private scalar) or anything else is refused, so a private key can never be registered by mistake. */
export const ecPublicJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().check(z.length(43), z.regex(BASE64URL)),
  y: z.string().check(z.length(43), z.regex(BASE64URL)),
});
export type EcPublicJwk = z.infer<typeof ecPublicJwkSchema>;

/** The ECDSA parameters every sign and verify uses. */
export const ES256_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const ES256_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

function subtleOf(subtle: SubtleCrypto | undefined): SubtleCrypto {
  const found = subtle ?? globalThis.crypto?.subtle;
  if (found === undefined) throw new Error('Web Crypto (crypto.subtle) is not available here');
  return found;
}

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('not base64url');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The key id: the JWK thumbprint (RFC 7638) of the public key, base64url SHA-256 of
 * `{"crv":"P-256","kty":"EC","x":...,"y":...}`. Derived from the key, never chosen, so the
 * device, the partner and Purse compute the same id independently and a registration can
 * never claim another key's id.
 */
export async function jwkThumbprint(jwk: EcPublicJwk, subtle?: SubtleCrypto): Promise<string> {
  const digest = await subtleOf(subtle).digest('SHA-256', encoder.encode(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
  return toBase64Url(new Uint8Array(digest));
}

/** Import a public JWK for verification. */
export function importAttestationKey(jwk: EcPublicJwk, subtle?: SubtleCrypto): Promise<CryptoKey> {
  return subtleOf(subtle).importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, ES256_KEY, true, ['verify']);
}

/** Generate a device key pair: the private key is non-extractable and never leaves the `CryptoKey`. */
export function generateAttestationKeyPair(subtle?: SubtleCrypto): Promise<CryptoKeyPair> {
  return subtleOf(subtle).generateKey(ES256_KEY, false, ['sign', 'verify']);
}

/** The public half of a generated pair as the JWK the device registers. */
export async function exportPublicJwk(publicKey: CryptoKey, subtle?: SubtleCrypto): Promise<EcPublicJwk> {
  const exported = await subtleOf(subtle).exportKey('jwk', publicKey);
  return ecPublicJwkSchema.parse({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });
}

// ---- The payload -----------------------------------------------------------------------------

/**
 * What is signed. `sourceRef` is the partner's reference for the scored thing and must
 * equal the `sourceRef` of the score it accompanies (for Sideout, the match id); `refs`
 * are the partner's further bindings (Sideout: `tournamentId`, `teamId`); `content` is what
 * was scored, in the partner's own canonical shape (Sideout: the match-oriented scoreline).
 * `keyId` and `timestamp` are inside the signed bytes too, so a signature is bound to one
 * key and one moment.
 */
export type AttestationPayload = {
  v: typeof ATTESTATION_VERSION;
  keyId: string;
  timestamp: string;
  sourceRef: string;
  refs: Record<string, string>;
  content: CanonicalValue;
};

export const attestationPayloadSchema = z.strictObject({
  v: z.literal(ATTESTATION_VERSION),
  keyId: z.string().check(z.length(43), z.regex(BASE64URL)),
  timestamp: z.string().check(z.regex(ATTESTATION_TIMESTAMP_SHAPE)),
  sourceRef: z.string().check(z.minLength(1), z.maxLength(255)),
  refs: z.record(z.string().check(z.minLength(1), z.maxLength(64)), z.string().check(z.minLength(1), z.maxLength(255))),
  content: canonicalValueSchema,
});

/** The canonical byte string of a payload: the domain prefix, then the canonical JSON, UTF-8. */
export function attestationBytes(payload: AttestationPayload): Uint8Array<ArrayBuffer> {
  const text = ATTESTATION_DOMAIN + canonicalJson(payload as unknown as CanonicalValue);
  const bytes = encoder.encode(text) as Uint8Array<ArrayBuffer>;
  if (bytes.length > ATTESTATION_MAX_BYTES) throw new RangeError(`attestation payload is ${bytes.length} bytes; at most ${ATTESTATION_MAX_BYTES} may be signed`);
  return bytes;
}

/** Sign a payload with the device's private key; the signature is base64url of the raw `r || s` bytes. */
export async function signAttestation(privateKey: CryptoKey, payload: AttestationPayload, subtle?: SubtleCrypto): Promise<string> {
  const signature = await subtleOf(subtle).sign(ES256_SIGN, privateKey, attestationBytes(payload));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Verify a signature over a payload with a public JWK. False for a signature that does not
 * match, a malformed signature, or a payload too large to have been signed; never throws
 * for bad input, only for a missing Web Crypto.
 */
export async function verifyAttestation(publicJwk: EcPublicJwk, payload: AttestationPayload, signature: string, subtle?: SubtleCrypto): Promise<boolean> {
  let bytes: Uint8Array<ArrayBuffer>;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    bytes = attestationBytes(payload);
    raw = fromBase64Url(signature);
  } catch {
    return false;
  }
  if (raw.length !== 64) return false;
  const key = await importAttestationKey(publicJwk, subtle);
  return subtleOf(subtle).verify(ES256_SIGN, key, raw, bytes);
}

// ---- On the wire -------------------------------------------------------------------------------

/**
 * An attestation as it accompanies a score in `POST /contests/:id/scores`. `userId` is the
 * Purse user whose registered device signed (a teammate's device may vouch for a whole
 * team's score; the partner says whose). Purse rebuilds the payload from these fields and
 * the score's own `sourceRef`, so the signed bytes are never taken from the wire.
 */
export const scoreAttestationInputSchema = z.strictObject({
  userId: z.string().check(z.minLength(1), z.maxLength(64)),
  keyId: z.string().check(z.length(43), z.regex(BASE64URL)),
  algorithm: z.enum(ATTESTATION_ALGORITHMS),
  signature: z.string().check(z.length(86), z.regex(BASE64URL)),
  timestamp: z.string().check(z.regex(ATTESTATION_TIMESTAMP_SHAPE)),
  refs: z.record(z.string().check(z.minLength(1), z.maxLength(64)), z.string().check(z.minLength(1), z.maxLength(255))),
  content: canonicalValueSchema,
});
export type ScoreAttestationInput = z.infer<typeof scoreAttestationInputSchema>;

/** The payload a wire attestation stands for, given the score it accompanies. */
export function payloadOf(attestation: Pick<ScoreAttestationInput, 'keyId' | 'timestamp' | 'refs' | 'content'>, sourceRef: string): AttestationPayload {
  return { v: ATTESTATION_VERSION, keyId: attestation.keyId, timestamp: attestation.timestamp, sourceRef, refs: attestation.refs, content: attestation.content };
}

/** A registered device: one public key of one user, as `POST /users/:id/devices` returns it. */
export type DeviceResource = {
  id: string;
  userId: string;
  keyId: string;
  algorithm: AttestationAlgorithm;
  publicKey: EcPublicJwk;
  /** The partner's label for the device (a team, a phone), never anything identifying. */
  label: string | null;
  registeredAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
};

/** What Purse recorded on a score whose batch carried an attestation, verbatim plus the verdict. */
export type ScoreAttestationResource = {
  state: Exclude<AttestationState, 'none'>;
  /** The device Purse verified against, or `null` when it holds none (`unverified`). */
  deviceId: string | null;
  userId: string;
  keyId: string;
  algorithm: AttestationAlgorithm;
  signature: string;
  timestamp: string;
  refs: Record<string, string>;
  content: CanonicalValue;
  checkedAt: string;
};
