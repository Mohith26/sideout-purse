import { createHash } from 'node:crypto';
import { canonicalJson } from '@purse/types';

import { scorelineContent } from './attestation';
import type { SetScore, Side } from './scoreline';

/**
 * The canonical form and hash the consensus machine compares (spec 5.2, rule 1). Kept
 * apart from `scoreline.ts`, which the score sheet imports in the browser to judge
 * legality as the player types: this module needs Node's `crypto`.
 *
 * Canonical form: sets ordered by number, always oriented from team A's side, keys in a
 * fixed order, no whitespace (`{"matchId":"…","sets":[[1,21,18],…]}`). Two honest
 * submissions of the same result, one typed by each team from its own side of the net,
 * produce byte-identical output and so one hash. It is the same `scorelineContent` a
 * phone signs (`attestation.ts`), written by the same canonical JSON, so the consensus
 * hash and a device signature never disagree about what a scoreline is.
 *
 * `perspective` says which team the submitter typed as "us": a team-B submitter enters
 * their own points first, and canonicalization flips them back to team A's side.
 */
export type Scoreline = { matchId: string; sets: readonly SetScore[] };

export function canonicalizeScoreline(scoreline: Scoreline, perspective: Side = 'a'): string {
  return canonicalJson(scorelineContent(scoreline.matchId, scoreline.sets, perspective));
}

/** SHA-256 hex of the canonical scoreline: what `score_submissions.hash` and `match_consensus.agreed_hash` store. */
export function hashScoreline(scoreline: Scoreline, perspective: Side = 'a'): string {
  return createHash('sha256').update(canonicalizeScoreline(scoreline, perspective)).digest('hex');
}
