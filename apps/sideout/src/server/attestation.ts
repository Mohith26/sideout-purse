import { verifyAttestation } from '@purse/types';

import type { Match, Team } from '../db/schema';
import { attestationPayload, judgeAttestationTimestamp, type StoredAttestation, type SubmittedAttestation } from '../domain/attestation';
import type { SetScore } from '../domain/scoreline';
import type { DbOrTx } from './db';
import { findTeamDevice } from './devices';
import { failure } from './http/errors';

/**
 * The server's check of a phone's signature (spec section 12, item 1), run inside the
 * score transaction after the team is resolved from `team_members` and the scoreline
 * judged legal, and before the consensus sees the submission. Everything the signature
 * binds to comes from Sideout's own rows, never from the request: the tournament, the
 * match, the submitting team, the canonical sets. The phone sent only its key id, the
 * signature and the moment it signed.
 *
 * A signature that fails any check refuses the submission with `invalid_attestation`
 * (422): a key the team never checked in, a key the organizer revoked (a scoreline queued
 * on a phone before its key was revoked is refused when it arrives, and the phone shows
 * why, never drops it silently), a timestamp in the future or older than the outbox
 * window, or a signature that does not verify. A submission with no attestation at all is
 * accepted as before (decision D5, option A): attestation is additive.
 */
export async function verifySubmittedAttestation(
  db: DbOrTx,
  input: { match: Pick<Match, 'id' | 'tournamentId'>; team: Pick<Team, 'id'>; sets: readonly SetScore[]; attestation: SubmittedAttestation; now: Date },
): Promise<StoredAttestation> {
  const { attestation, now } = input;
  const timing = judgeAttestationTimestamp(attestation.timestamp, now);
  if (!timing.ok) throw failure.invalidAttestation(timing.code, timing.message, { keyId: attestation.keyId });

  const device = await findTeamDevice(db, input.team.id, attestation.keyId);
  if (device === null) {
    throw failure.invalidAttestation('unknown_device', 'This phone is not checked in for your team. Check it in from the register screen, then submit again.', { keyId: attestation.keyId, teamId: input.team.id });
  }
  if (device.revokedAt !== null) {
    throw failure.invalidAttestation('device_revoked', 'The organizer revoked this phone’s check-in. Check the phone in again from the register screen, then submit again.', {
      keyId: attestation.keyId,
      deviceId: device.id,
      revokedAt: device.revokedAt.toISOString(),
    });
  }

  const payload = attestationPayload({
    keyId: attestation.keyId,
    timestamp: attestation.timestamp,
    tournamentId: input.match.tournamentId,
    matchId: input.match.id,
    teamId: input.team.id,
    sets: input.sets,
  });
  const valid = await verifyAttestation(device.publicKey, payload, attestation.signature);
  if (!valid) {
    throw failure.invalidAttestation('signature_invalid', 'The signature does not match this scoreline for this match and team. Submit the scoreline again from your phone.', {
      keyId: attestation.keyId,
      deviceId: device.id,
      matchId: input.match.id,
    });
  }
  return {
    deviceId: device.id,
    userId: device.userId,
    keyId: device.keyId,
    algorithm: 'ES256',
    signature: attestation.signature,
    timestamp: attestation.timestamp,
    refs: { tournamentId: input.match.tournamentId, teamId: input.team.id },
    content: payload.content as StoredAttestation['content'],
    verifiedAt: now.toISOString(),
  };
}
