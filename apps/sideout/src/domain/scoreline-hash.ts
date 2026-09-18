import { createHash } from 'node:crypto';

import type { SetScore, Side } from './scoreline';

/**
 * The canonical form and hash the consensus machine compares (spec 5.2, rule 1). Kept
 * apart from `scoreline.ts`, which the score sheet imports in the browser to judge
 * legality as the player types: this module needs Node's `crypto`.
 *
 * Canonical form: sets ordered by number, always oriented from team A's side, keys in a
 * fixed order, no whitespace. Two honest submissions of the same result, one typed by each
 * team from its own side of the net, produce byte-identical output and so one hash.
 *
 * `perspective` says which team the submitter typed as "us": a team-B submitter enters
 * their own points first, and canonicalization flips them back to team A's side.
 */
export type Scoreline = { matchId: string; sets: readonly SetScore[] };

export function canonicalizeScoreline(scoreline: Scoreline, perspective: Side = 'a'): string {
  const sets = [...scoreline.sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => {
      const a = perspective === 'a' ? s.teamAPoints : s.teamBPoints;
      const b = perspective === 'a' ? s.teamBPoints : s.teamAPoints;
      return `[${s.setNumber},${a},${b}]`;
    });
  return `{"matchId":${JSON.stringify(scoreline.matchId)},"sets":[${sets.join(',')}]}`;
}

/** SHA-256 hex of the canonical scoreline: what `score_submissions.hash` and `match_consensus.agreed_hash` store. */
export function hashScoreline(scoreline: Scoreline, perspective: Side = 'a'): string {
  return createHash('sha256').update(canonicalizeScoreline(scoreline, perspective)).digest('hex');
}
