import { ATTESTATION_TIMESTAMP_SHAPE, ATTESTATION_VERSION, type AttestationPayload, type CanonicalValue, type EcPublicJwk, type ScoreAttestationInput } from '@purse/types';
import { z } from 'zod';

import type { SetScore, Side } from './scoreline';

/**
 * Signed score attestation, the pure part (spec section 12, item 1; `docs/attestation.md`).
 * No I/O: this module builds the exact payload a phone signs and the server verifies, and
 * judges a timestamp; `lib/attestation/device.ts` holds the key in the browser,
 * `server/attestation.ts` checks a submission against the registered key, and
 * `server/purse/scores.ts` forwards what was verified to Purse.
 *
 * The signed content is the canonical scoreline in match orientation, the same bytes
 * `hashScoreline` digests (`scoreline-hash.ts` builds its string from `scorelineContent`
 * too, so the consensus hash and the signature can never disagree about what a scoreline
 * is). The payload binds it to the tournament, the match, the submitting team, the key and
 * the moment of signing, so a signature can never be replayed onto another match or team.
 */

/** What a phone sends with its scoreline: the server rebuilds everything else from its own rows. */
export const submittedAttestationSchema = z.strictObject({
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a JWK thumbprint'),
  algorithm: z.literal('ES256'),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'a base64url ES256 signature'),
  timestamp: z.string().regex(ATTESTATION_TIMESTAMP_SHAPE, 'an ISO instant with milliseconds'),
});
export type SubmittedAttestation = z.infer<typeof submittedAttestationSchema>;

/** What `score_submissions.attestation` holds once the signature verified. Never a private key, never anything but public material. */
export type StoredAttestation = {
  deviceId: string;
  /** The Sideout user whose registered device signed. */
  userId: string;
  keyId: string;
  algorithm: 'ES256';
  signature: string;
  timestamp: string;
  refs: { tournamentId: string; teamId: string };
  content: ScorelineContent;
  verifiedAt: string;
};

export type ScorelineContent = { matchId: string; sets: Array<[number, number, number]> };

/** The canonical scoreline as signed content: sets ordered by number, always from team A's side. */
export function scorelineContent(matchId: string, sets: readonly SetScore[], perspective: Side = 'a'): ScorelineContent {
  const ordered = [...sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s): [number, number, number] => [s.setNumber, perspective === 'a' ? s.teamAPoints : s.teamBPoints, perspective === 'a' ? s.teamBPoints : s.teamAPoints]);
  return { matchId, sets: ordered };
}

export type AttestationBinding = {
  keyId: string;
  timestamp: string;
  tournamentId: string;
  matchId: string;
  teamId: string;
  /** Match-oriented sets. */
  sets: readonly SetScore[];
};

/** The payload both the phone and the server build, byte for byte the same, from the same facts. */
export function attestationPayload(binding: AttestationBinding): AttestationPayload {
  return {
    v: ATTESTATION_VERSION,
    keyId: binding.keyId,
    timestamp: binding.timestamp,
    sourceRef: binding.matchId,
    refs: { tournamentId: binding.tournamentId, teamId: binding.teamId },
    content: scorelineContent(binding.matchId, binding.sets) as unknown as CanonicalValue,
  };
}

/** How far ahead of the server's clock a phone's timestamp may be. */
export const ATTESTATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** How old a signature may be when it arrives: a scoreline queued on a phone with no signal is replayed for up to three days. */
export const ATTESTATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type TimestampVerdict = { ok: true } | { ok: false; code: 'timestamp_invalid' | 'timestamp_future' | 'timestamp_expired'; message: string };

export function judgeAttestationTimestamp(timestamp: string, now: Date): TimestampVerdict {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== timestamp) return { ok: false, code: 'timestamp_invalid', message: 'The signature’s timestamp is not an instant.' };
  if (at.getTime() > now.getTime() + ATTESTATION_CLOCK_SKEW_MS) return { ok: false, code: 'timestamp_future', message: 'The signature’s timestamp is in the future.' };
  if (at.getTime() < now.getTime() - ATTESTATION_MAX_AGE_MS) {
    return { ok: false, code: 'timestamp_expired', message: 'The signature is more than three days old. Sign the scoreline again from this phone.' };
  }
  return { ok: true };
}

/** The attestation as Purse takes it with a score, attributed to the signer's linked Purse user. */
export function toPurseAttestation(stored: StoredAttestation, purseUserId: string): ScoreAttestationInput {
  return {
    userId: purseUserId,
    keyId: stored.keyId,
    algorithm: stored.algorithm,
    signature: stored.signature,
    timestamp: stored.timestamp,
    refs: { ...stored.refs },
    content: stored.content as unknown as CanonicalValue,
  };
}

/** A registered device as pages and the API show it: public material only. */
export type DeviceView = {
  id: string;
  teamId: string;
  userId: string;
  keyId: string;
  algorithm: 'ES256';
  publicKey: EcPublicJwk;
  registeredAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  /** Whether Purse holds the same key for the member's linked user. */
  mirrored: boolean;
};

/** The audit vocabulary. */
export const DEVICE_AUDIT = {
  registered: 'device.registered',
  revoked: 'device.revoked',
  mirrored: 'device.purse_mirrored',
  mirrorFailed: 'device.purse_mirror_failed',
} as const;
