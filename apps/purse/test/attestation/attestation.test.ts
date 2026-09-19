import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attestationBytes, ES256_KEY, exportPublicJwk, generateAttestationKeyPair, jwkThumbprint, signAttestation, type AttestationPayload, type EcPublicJwk, type ScoreAttestationInput } from '@purse/types';
import { newId } from '@repo/ids';

import { currentScores, submitScores, enterContest } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { auditLog, contestScores, userDevices } from '../../src/db/schema';
import { findDeviceByKey, isUsersError, listDevices, registerDevice, revokeDevice } from '../../src/users';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, contestError, enterAll, inProgress, makeContest, OPERATOR, TENANT_ACTOR, type Arena } from '../contests/fixtures';
import { ATTESTATION_VECTORS as vectors } from './vectors';

/**
 * Signed score attestation on the Purse side (spec section 12, item 1): the device
 * registry (`src/users/devices.ts`) and the check every attested score goes through
 * (`src/attestation/verify.ts`) inside `submitScores`. The fixed vectors pin the canonical
 * form: the pinned signature verifies against the pinned key for the pinned match and
 * fails for a wrong key, a tampered scoreline, another match or a future timestamp; a key
 * Purse does not hold is recorded `unverified` and a revoked one is refused.
 */
const NOW = new Date('2026-09-19T16:10:00.000Z');
const VECTOR_MATCH = vectors.payload.sourceRef;
const publicJwk = vectors.publicJwk as EcPublicJwk;

async function importPrivate(): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { ...vectors.privateJwk, ext: true }, ES256_KEY, false, ['sign']);
}

function wire(userId: string, overrides: Partial<ScoreAttestationInput> = {}): ScoreAttestationInput {
  return {
    userId,
    keyId: vectors.keyId,
    algorithm: 'ES256',
    signature: vectors.signature,
    timestamp: vectors.payload.timestamp,
    refs: { ...vectors.payload.refs },
    content: JSON.parse(JSON.stringify(vectors.payload.content)) as ScoreAttestationInput['content'],
    ...overrides,
  };
}

describe('devices', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 4 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? newId('usr');

  it('registers a public key under its thumbprint, once, and audits it', async () => {
    const first = await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, label: 'phone', actor: TENANT_ACTOR, requestId: 'req-dev-1' });
    expect(first.created).toBe(true);
    expect(first.device.keyId).toBe(vectors.keyId);
    expect(first.device.publicKey).toEqual(publicJwk);
    expect(first.device.createdBy).toBe('tenant:sideout');
    const again = await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, actor: TENANT_ACTOR });
    expect(again.created).toBe(false);
    expect(again.device.id).toBe(first.device.id);
    // The same key for another user is another device.
    const other = await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(1), publicKey: publicJwk, actor: TENANT_ACTOR });
    expect(other.created).toBe(true);
    expect(other.device.keyId).toBe(vectors.keyId);
    const audits = await runtime.db.select().from(auditLog).where(eq(auditLog.action, 'user.device.registered'));
    expect(audits).toHaveLength(2);
    expect(audits[0]?.requestId).toBe('req-dev-1');
    expect((await listDevices(runtime.db, arena.tenantId, user(0))).map((d) => d.id)).toEqual([first.device.id]);
  });

  it('refuses a private key, a foreign JWK and a user of another tenant', async () => {
    const withD = await rejection(registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: vectors.privateJwk as unknown as EcPublicJwk, actor: TENANT_ACTOR }));
    expect(isUsersError(withD, 'invalid_input')).toBe(true);
    const rsa = await rejection(registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: { kty: 'RSA', n: 'x', e: 'AQAB' } as unknown as EcPublicJwk, actor: TENANT_ACTOR }));
    expect(isUsersError(rsa, 'invalid_input')).toBe(true);
    const nobody = await rejection(registerDevice(runtime.db, { tenantId: arena.tenantId, userId: newId('usr'), publicKey: publicJwk, actor: TENANT_ACTOR }));
    expect(isUsersError(nobody, 'user_not_found')).toBe(true);
    expect(await runtime.db.select().from(userDevices)).toHaveLength(0);
  });

  it('revokes once, keeps the revocation, and lets the key be registered again as a new row', async () => {
    const { device } = await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, actor: TENANT_ACTOR });
    const revoked = await revokeDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), deviceId: device.id, reason: 'phone lost', actor: OPERATOR });
    expect(revoked.revoked).toBe(true);
    expect(revoked.device.revokedAt).not.toBeNull();
    expect(revoked.device.revokedBy).toBe('operator:op_test');
    expect(revoked.device.revokedReason).toBe('phone lost');
    const twice = await revokeDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), deviceId: device.id, actor: OPERATOR });
    expect(twice.revoked).toBe(false);
    expect(twice.device.revokedAt?.toISOString()).toBe(revoked.device.revokedAt?.toISOString());
    // The database refuses to un-revoke, even for the owner.
    const undo = await rejection(migrator.sql`update user_devices set revoked_at = null, revoked_by = null where id = ${device.id}`);
    expect(String(undo)).toMatch(/stays revoked/);
    // A found-again phone registers the same key as a new row; the old one stays revoked.
    const again = await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, actor: TENANT_ACTOR });
    expect(again.created).toBe(true);
    expect(again.device.id).not.toBe(device.id);
    expect((await findDeviceByKey(runtime.db, user(0), vectors.keyId))?.id).toBe(again.device.id);
    const missing = await rejection(revokeDevice(runtime.db, { tenantId: arena.tenantId, userId: user(1), deviceId: device.id, actor: OPERATOR }));
    expect(isUsersError(missing, 'device_not_found')).toBe(true);
  });
});

describe('attested scores', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 4 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? newId('usr');

  async function submit(contestId: string, entries: Array<{ userId: string; sourceRef?: string | null; attestation?: ScoreAttestationInput | null }>, k = key('att')) {
    return submitScores(runtime.db, {
      tenantId: arena.tenantId,
      contestId,
      scores: entries.map((e) => ({ userId: e.userId, score: 1, attemptFinished: false, sourceRef: e.sourceRef === undefined ? VECTOR_MATCH : e.sourceRef, attestation: e.attestation ?? null })),
      idempotencyKey: k,
      actor: TENANT_ACTOR,
      now: NOW,
    });
  }

  it('verifies the pinned vector against the registered key, for the attesting user and a teammate, and records the material', async () => {
    const contest = await inProgress(runtime.db, arena);
    await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, actor: TENANT_ACTOR });
    const result = await submit(contest.id, [
      { userId: user(0), attestation: wire(user(0)) },
      { userId: user(1), attestation: wire(user(0)) },
      { userId: user(2) },
    ]);
    expect(result.scores.map((s) => s.attestationState)).toEqual(['verified', 'verified', 'none']);
    const material = result.scores[0]?.attestation;
    expect(material).toMatchObject({ state: 'verified', userId: user(0), keyId: vectors.keyId, signature: vectors.signature, timestamp: vectors.payload.timestamp, refs: vectors.payload.refs, checkedAt: NOW.toISOString() });
    expect(material?.deviceId).toMatch(/^udv_/);
    expect(result.scores[2]?.attestation).toBeNull();
    // The replay answers from the store with the same rows and the same verdict.
    const again = await submit(contest.id, [{ userId: user(0), attestation: wire(user(0)) }, { userId: user(1), attestation: wire(user(0)) }, { userId: user(2) }], 'att-replay');
    const first = await submit(contest.id, [{ userId: user(0), attestation: wire(user(0)) }, { userId: user(1), attestation: wire(user(0)) }, { userId: user(2) }], 'att-replay');
    expect(first.replayed).toBe(true);
    expect(first.scores.map((s) => s.id)).toEqual(again.scores.map((s) => s.id));
    expect(first.scores.map((s) => s.attestationState)).toEqual(['verified', 'verified', 'none']);
    expect(await runtime.db.select().from(contestScores)).toHaveLength(6);
  });

  it('refuses a wrong key, a tampered scoreline, another match and a future timestamp, and writes nothing', async () => {
    const contest = await inProgress(runtime.db, arena);
    await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, actor: TENANT_ACTOR });
    const other = await generateAttestationKeyPair();
    const otherJwk = await exportPublicJwk(other.publicKey);
    await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(1), publicKey: otherJwk, actor: TENANT_ACTOR });

    const cases: Array<[string, Array<{ userId: string; sourceRef?: string | null; attestation: ScoreAttestationInput }>]> = [
      // Signed by the vector key, presented as user(1)'s device (whose key is `other`): the wrong key.
      ['attestation_signature_invalid', [{ userId: user(1), attestation: wire(user(1), { keyId: await jwkThumbprint(otherJwk) }) }]],
      // One point moved.
      ['attestation_signature_invalid', [{ userId: user(0), attestation: wire(user(0), { content: { matchId: VECTOR_MATCH, sets: [[1, 21, 18], [2, 19, 21], [3, 15, 12]] } }) }]],
      // Replayed onto another match.
      ['attestation_signature_invalid', [{ userId: user(0), sourceRef: 'mch_0192f1a0-0000-7000-8000-000000000102', attestation: wire(user(0)) }]],
      // Replayed onto another team.
      ['attestation_signature_invalid', [{ userId: user(0), attestation: wire(user(0), { refs: { ...vectors.payload.refs, teamId: 'tm_0192f1a0-0000-7000-8000-000000000012' } }) }]],
      // The future, beyond clock skew.
      ['attestation_timestamp_future', [{ userId: user(0), attestation: wire(user(0), { timestamp: '2026-09-19T16:20:00.000Z' }) }]],
      ['attestation_timestamp_invalid', [{ userId: user(0), attestation: wire(user(0), { timestamp: '2026-13-19T16:05:00.000Z' }) }]],
      // Nothing to bind to.
      ['attestation_source_required', [{ userId: user(0), sourceRef: null, attestation: wire(user(0)) }]],
      // The attesting user is not in the contest.
      ['attestation_user_not_participant', [{ userId: user(0), attestation: wire(newId('usr')) }]],
    ];
    for (const [code, entries] of cases) {
      const error = await contestError(submit(contest.id, entries, key(code)));
      expect(error.code, code).toBe(code);
      expect(error.apiType, code).toBe('invalid_attestation');
      expect(error.detail, code).toMatchObject({ contestId: contest.id });
    }
    expect(await currentScores(runtime.db, contest.id)).toEqual([]);
    // A malformed attestation is a plain input error, before any check.
    const malformed = await contestError(submit(contest.id, [{ userId: user(0), attestation: { ...wire(user(0)), signature: 'short' } }], key('malformed')));
    expect(malformed.code).toBe('invalid_input');
    expect(malformed.detail).toMatchObject({ field: 'scores.0.attestation' });
  });

  it('records a key Purse does not hold as unverified, and refuses a revoked one', async () => {
    const contest = await inProgress(runtime.db, arena);
    const unknown = await submit(contest.id, [{ userId: user(0), attestation: wire(user(0)) }], key('unknown'));
    expect(unknown.scores[0]?.attestationState).toBe('unverified');
    expect(unknown.scores[0]?.attestation).toMatchObject({ state: 'unverified', deviceId: null, keyId: vectors.keyId });

    const { device } = await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: publicJwk, actor: TENANT_ACTOR });
    await revokeDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), deviceId: device.id, actor: OPERATOR });
    const error = await contestError(submit(contest.id, [{ userId: user(0), attestation: wire(user(0)) }], key('revoked')));
    expect(error.code).toBe('attestation_device_revoked');
    expect(error.detail).toMatchObject({ deviceId: device.id });
    expect((await currentScores(runtime.db, contest.id)).map((s) => s.attestationState)).toEqual(['unverified']);
  });

  it('binds the signed team to the participants’ teamRef when both are known', async () => {
    const created = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, created.id, 'open');
    await enterAll(runtime.db, arena, created.id, [user(0), user(1)]);
    // user(2) enters under a team ref that is not the one the vector signed.
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: created.id, userId: user(2), teamRef: 'tm_elsewhere', idempotencyKey: key('enter-2'), actor: TENANT_ACTOR });
    const contest = await advance(runtime.db, arena, created.id, 'in_progress');
    await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(2), publicKey: publicJwk, actor: TENANT_ACTOR });
    const error = await contestError(submit(contest.id, [{ userId: user(2), attestation: wire(user(2)) }], key('team')));
    expect(error.code).toBe('attestation_team_mismatch');
    expect(error.detail).toMatchObject({ signedTeam: vectors.payload.refs.teamId, teamRef: 'tm_elsewhere' });
  });

  it('a fresh device signs a fresh payload the service verifies, and any byte change is refused', async () => {
    const contest = await inProgress(runtime.db, arena);
    const pair = await generateAttestationKeyPair();
    const jwk = await exportPublicJwk(pair.publicKey);
    const keyId = await jwkThumbprint(jwk);
    await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(0), publicKey: jwk, actor: TENANT_ACTOR });
    const sourceRef = `mch_${crypto.randomUUID()}`;
    const payload: AttestationPayload = { v: 1, keyId, timestamp: new Date(NOW.getTime() - 60_000).toISOString(), sourceRef, refs: { tournamentId: 'trn_x', teamId: 'tm_x' }, content: { matchId: sourceRef, sets: [[1, 21, 19]] } };
    const signature = await signAttestation(pair.privateKey, payload);
    const attestation: ScoreAttestationInput = { userId: user(0), keyId, algorithm: 'ES256', signature, timestamp: payload.timestamp, refs: payload.refs, content: payload.content };
    const ok = await submit(contest.id, [{ userId: user(0), sourceRef, attestation }], key('fresh'));
    expect(ok.scores[0]?.attestationState).toBe('verified');
    expect(attestationBytes(payload).length).toBeGreaterThan(0);
    const flipped = await contestError(submit(contest.id, [{ userId: user(0), sourceRef, attestation: { ...attestation, content: { matchId: sourceRef, sets: [[1, 21, 18]] } } }], key('flipped')));
    expect(flipped.code).toBe('attestation_signature_invalid');
    // The pinned private key still produces something the pinned public key verifies (the vectors did not drift).
    const priv = await importPrivate();
    const fresh = { ...(vectors.payload as unknown as AttestationPayload), timestamp: NOW.toISOString() };
    const freshSignature = await signAttestation(priv, fresh);
    await registerDevice(runtime.db, { tenantId: arena.tenantId, userId: user(1), publicKey: publicJwk, actor: TENANT_ACTOR });
    const pinned = await submit(contest.id, [{ userId: user(1), attestation: wire(user(1), { signature: freshSignature, timestamp: fresh.timestamp }) }], key('pinned'));
    expect(pinned.scores[0]?.attestationState).toBe('verified');
  });
});
