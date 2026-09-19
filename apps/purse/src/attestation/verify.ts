import { payloadOf, verifyAttestation, type ScoreAttestationInput, type ScoreAttestationResource } from '@purse/types';
import { isId } from '@repo/ids';

import { ContestError } from '../contests/errors';
import type { DbOrTx } from '../db/client';
import { findDeviceByKey } from '../users/devices';

/**
 * Purse's own check of a score's attestation (spec section 12, item 1), run inside the
 * scores transaction before any row is written. The partner verified the signature once
 * already; Purse trusts nothing of that and checks what it can against its own copy of
 * the key:
 *
 * - the attesting user is an entered participant of the contest, and the score names a
 *   `sourceRef` (the payload binds to it; without one there is nothing to bind);
 * - the timestamp is a real instant and not in the future beyond clock skew (how old it
 *   may be is the partner's rule: an offline phone signs long before it can send);
 * - when the attesting user's participant row or the scored user's carries a `teamRef`,
 *   it matches the `teamId` the device signed, so a signature is never carried onto
 *   another team;
 * - the key is one Purse holds for that user and is not revoked;
 * - the signature verifies over the payload rebuilt from the wire fields and the score's
 *   own `sourceRef` (never over bytes taken from the wire).
 *
 * A key Purse does not hold at all is `unverified`: the attestation is recorded verbatim
 * for the record, the score is accepted as an unattested score would be (decision D5
 * option A is unchanged), and the console shows the gap. Everything else that fails is
 * refused with the `invalid_attestation` type (422): the request was well formed, the
 * proof was not.
 */
export const ATTESTATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type AttestationSubject = {
  contestId: string;
  /** The scored user. */
  userId: string;
  sourceRef: string | null;
  attestation: ScoreAttestationInput;
};

export type ParticipantRef = { userId: string; state: string; teamRef: string | null };

export type AttestationVerdict = { state: 'verified' | 'unverified'; material: ScoreAttestationResource };

export async function checkAttestation(db: DbOrTx, subject: AttestationSubject, participants: ReadonlyMap<string, ParticipantRef>, now: Date): Promise<AttestationVerdict> {
  const { attestation, contestId } = subject;
  const at = (reason: string, detail: Record<string, unknown>) => ({ contestId, userId: subject.userId, attestingUserId: attestation.userId, keyId: attestation.keyId, reason, ...detail });

  if (subject.sourceRef === null) {
    throw new ContestError('attestation_source_required', 'An attested score must name the sourceRef its signature binds to', at('source_required', {}));
  }
  if (!isId(attestation.userId, 'usr')) {
    throw new ContestError('attestation_user_not_participant', 'attestation.userId must be a usr_ id', at('user_not_participant', {}));
  }
  const attester = participants.get(attestation.userId);
  if (attester === undefined || attester.state !== 'entered') {
    throw new ContestError('attestation_user_not_participant', `The attesting user ${attestation.userId} is not an entered participant of contest ${contestId}`, at('user_not_participant', { participantState: attester?.state ?? null }));
  }

  const signedAt = new Date(attestation.timestamp);
  if (Number.isNaN(signedAt.getTime()) || signedAt.toISOString() !== attestation.timestamp) {
    throw new ContestError('attestation_timestamp_invalid', `attestation.timestamp ${attestation.timestamp} is not an instant`, at('timestamp_invalid', {}));
  }
  if (signedAt.getTime() > now.getTime() + ATTESTATION_CLOCK_SKEW_MS) {
    throw new ContestError('attestation_timestamp_future', `attestation.timestamp ${attestation.timestamp} is in the future`, at('timestamp_future', { now: now.toISOString() }));
  }

  const signedTeam = attestation.refs['teamId'];
  if (signedTeam !== undefined) {
    const scored = participants.get(subject.userId);
    for (const [role, participant] of [
      ['attesting', attester],
      ['scored', scored],
    ] as const) {
      if (participant !== undefined && participant.teamRef !== null && participant.teamRef !== signedTeam) {
        throw new ContestError('attestation_team_mismatch', `The signature names team ${signedTeam} but the ${role} user entered as ${participant.teamRef}`, at('team_mismatch', { signedTeam, teamRef: participant.teamRef, role }));
      }
    }
  }

  const checkedAt = now.toISOString();
  const material = (state: 'verified' | 'unverified', deviceId: string | null): ScoreAttestationResource => ({
    state,
    deviceId,
    userId: attestation.userId,
    keyId: attestation.keyId,
    algorithm: attestation.algorithm,
    signature: attestation.signature,
    timestamp: attestation.timestamp,
    refs: attestation.refs,
    content: attestation.content,
    checkedAt,
  });

  const device = await findDeviceByKey(db, attestation.userId, attestation.keyId);
  if (device === null) return { state: 'unverified', material: material('unverified', null) };
  if (device.revokedAt !== null) {
    throw new ContestError('attestation_device_revoked', `Device ${device.id} was revoked at ${device.revokedAt.toISOString()}; a score it signed is refused`, at('device_revoked', { deviceId: device.id, revokedAt: device.revokedAt.toISOString() }));
  }
  const valid = await verifyAttestation(device.publicKey, payloadOf(attestation, subject.sourceRef), attestation.signature);
  if (!valid) {
    throw new ContestError('attestation_signature_invalid', `The signature does not verify against device ${device.id} over this score's canonical form`, at('signature_invalid', { deviceId: device.id, sourceRef: subject.sourceRef }));
  }
  return { state: 'verified', material: material('verified', device.id) };
}
