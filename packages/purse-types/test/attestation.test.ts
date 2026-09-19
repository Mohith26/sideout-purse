import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ATTESTATION_DOMAIN,
  ATTESTATION_MAX_BYTES,
  attestationBytes,
  attestationPayloadSchema,
  canonicalJson,
  ecPublicJwkSchema,
  ES256_KEY,
  exportPublicJwk,
  fromBase64Url,
  generateAttestationKeyPair,
  jwkThumbprint,
  payloadOf,
  scoreAttestationInputSchema,
  signAttestation,
  toBase64Url,
  verifyAttestation,
  type AttestationPayload,
  type CanonicalValue,
  type EcPublicJwk,
} from '../src/index';
import { ATTESTATION_VECTORS as vectors } from './attestation-vectors';

/**
 * The attestation contract, pinned (docs/attestation.md): the canonical bytes of the
 * fixed payload, the key id of the fixed key, and a signature made once with the fixed
 * private key that must keep verifying for as long as the canonical form stands. A
 * byte's drift in the form fails the pinned signature; the property test then shows that
 * the same holds for every byte of every payload.
 */
const payload = vectors.payload as unknown as AttestationPayload;
const publicJwk = vectors.publicJwk as EcPublicJwk;
const otherJwk = vectors.otherPublicJwk as EcPublicJwk;
const decoder = new TextDecoder();

async function importPrivate(): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { ...vectors.privateJwk, ext: true }, ES256_KEY, false, ['sign']);
}

describe('canonical JSON', () => {
  it('sorts keys, writes no whitespace and admits integers only', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
    expect(() => canonicalJson(1.5)).toThrow(/safe integers/);
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integers/);
    expect(() => canonicalJson(undefined as unknown as CanonicalValue)).toThrow(/cannot hold/);
    expect(canonicalJson('quote " and   line')).toBe(JSON.stringify('quote " and   line'));
  });

  it('is byte-identical for the same value in any key order (property)', () => {
    const value = fc.letrec<{ value: CanonicalValue }>((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.string({ maxLength: 12 }),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie('value'), { maxLength: 4 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie('value'), { maxKeys: 4 }),
      ),
    })).value;
    fc.assert(
      fc.property(value, (v) => {
        const shuffled = JSON.parse(JSON.stringify(v, (_key, inner: unknown) => (inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).reverse()) : inner))) as CanonicalValue;
        expect(canonicalJson(shuffled)).toBe(canonicalJson(v));
        expect(JSON.parse(canonicalJson(v))).toEqual(v);
      }),
    );
  });
});

describe('the pinned vectors', () => {
  it('produce the pinned canonical bytes', () => {
    expect(decoder.decode(attestationBytes(payload))).toBe(vectors.canonical);
    expect(vectors.canonical.startsWith(ATTESTATION_DOMAIN)).toBe(true);
  });

  it('derive the pinned key id from the public key (RFC 7638 thumbprint)', async () => {
    expect(await jwkThumbprint(publicJwk)).toBe(vectors.keyId);
    expect(payload.keyId).toBe(vectors.keyId);
    // The thumbprint depends on the key alone: a `d` or a `kid` on the JWK does not move it.
    expect(await jwkThumbprint({ ...publicJwk, d: 'ignored' } as EcPublicJwk)).toBe(vectors.keyId);
  });

  it('verify the pinned signature with the pinned key, and refuse every corruption', async () => {
    expect(await verifyAttestation(publicJwk, payload, vectors.signature)).toBe(true);
    // Wrong key.
    expect(await verifyAttestation(otherJwk, payload, vectors.signature)).toBe(false);
    // Tampered scoreline: one point moved.
    const tampered = { ...payload, content: { matchId: (payload.content as { matchId: string }).matchId, sets: [[1, 21, 18], [2, 19, 21], [3, 15, 12]] } };
    expect(await verifyAttestation(publicJwk, tampered, vectors.signature)).toBe(false);
    // Replayed onto another match, team, tournament, key or moment.
    expect(await verifyAttestation(publicJwk, { ...payload, sourceRef: 'mch_0192f1a0-0000-7000-8000-000000000102' }, vectors.signature)).toBe(false);
    expect(await verifyAttestation(publicJwk, { ...payload, refs: { ...payload.refs, teamId: 'tm_0192f1a0-0000-7000-8000-000000000012' } }, vectors.signature)).toBe(false);
    expect(await verifyAttestation(publicJwk, { ...payload, refs: { ...payload.refs, tournamentId: 'trn_0192f1a0-0000-7000-8000-000000000002' } }, vectors.signature)).toBe(false);
    expect(await verifyAttestation(publicJwk, { ...payload, timestamp: '2026-09-19T16:05:00.001Z' }, vectors.signature)).toBe(false);
    // A malformed or truncated signature is false, never a throw.
    expect(await verifyAttestation(publicJwk, payload, vectors.signature.slice(0, -2))).toBe(false);
    expect(await verifyAttestation(publicJwk, payload, 'not base64url!')).toBe(false);
  });

  it('any byte change to the canonical form invalidates the signature (property)', async () => {
    const key = await crypto.subtle.importKey('jwk', { ...publicJwk, ext: true }, ES256_KEY, true, ['verify']);
    const bytes = attestationBytes(payload);
    const signature = fromBase64Url(vectors.signature);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, bytes)).toBe(true);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), async (index, delta) => {
        const mutated = new Uint8Array(bytes);
        mutated[index] = ((mutated[index] ?? 0) + delta) & 0xff;
        expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, mutated)).toBe(false);
      }),
      { numRuns: 64 },
    );
  });
});

describe('a fresh device', () => {
  it('signs with a non-extractable key and the partner verifies with the exported public JWK', async () => {
    const pair = await generateAttestationKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    const jwk = await exportPublicJwk(pair.publicKey);
    expect(ecPublicJwkSchema.safeParse(jwk).success).toBe(true);
    const keyId = await jwkThumbprint(jwk);
    const fresh: AttestationPayload = { ...payload, keyId, timestamp: new Date().toISOString() };
    const signature = await signAttestation(pair.privateKey, fresh);
    expect(signature).toHaveLength(86);
    expect(await verifyAttestation(jwk, fresh, signature)).toBe(true);
    expect(await verifyAttestation(publicJwk, fresh, signature)).toBe(false);
    // The wire shape carries everything but the source ref, and `payloadOf` puts it back.
    const wire = scoreAttestationInputSchema.parse({ userId: 'usr_x', keyId, algorithm: 'ES256', signature, timestamp: fresh.timestamp, refs: fresh.refs, content: fresh.content });
    expect(payloadOf(wire, fresh.sourceRef)).toEqual(fresh);
  });

  it('the pinned private key still signs something the pinned public key verifies', async () => {
    const priv = await importPrivate();
    const signature = await signAttestation(priv, payload);
    expect(await verifyAttestation(publicJwk, payload, signature)).toBe(true);
  });
});

describe('the schemas', () => {
  it('refuse a private key, a float, a loose timestamp and an oversized payload', () => {
    expect(ecPublicJwkSchema.safeParse(vectors.privateJwk).success).toBe(false);
    expect(ecPublicJwkSchema.safeParse({ ...publicJwk, kid: 'x' }).success).toBe(false);
    expect(attestationPayloadSchema.safeParse(payload).success).toBe(true);
    expect(attestationPayloadSchema.safeParse({ ...payload, content: { n: 1.5 } }).success).toBe(false);
    expect(attestationPayloadSchema.safeParse({ ...payload, timestamp: '2026-09-19T16:05:00Z' }).success).toBe(false);
    expect(attestationPayloadSchema.safeParse({ ...payload, v: 2 }).success).toBe(false);
    expect(() => attestationBytes({ ...payload, content: 'x'.repeat(ATTESTATION_MAX_BYTES) })).toThrow(/at most/);
  });

  it('base64url round-trips', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 96 }), (bytes) => {
        const text = toBase64Url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect([...fromBase64Url(text)]).toEqual([...bytes]);
      }),
    );
  });
});
