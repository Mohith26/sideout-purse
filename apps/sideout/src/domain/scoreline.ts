import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { BestOf } from '../db/schema';

/**
 * Beach volleyball scoreline rules and the canonical hash the consensus state machine
 * compares (system spec 5.2, rules 1 and 3). Pure functions, no I/O. Phase 7 builds the
 * consensus state machine on these; the seed uses them today so every seeded result is a
 * legal one.
 */

export const SET_TARGET = 21;
export const DECIDING_SET_TARGET = 15;
export const WIN_BY = 2;

export type Side = 'a' | 'b';

export const setScoreSchema = z.object({
  setNumber: z.number().int().min(1).max(3),
  teamAPoints: z.number().int().min(0).max(99),
  teamBPoints: z.number().int().min(0).max(99),
});
export type SetScore = z.infer<typeof setScoreSchema>;

export const scorelineSchema = z.object({
  matchId: z.string().min(1),
  sets: z.array(setScoreSchema).min(1).max(3),
});
export type Scoreline = z.infer<typeof scorelineSchema>;

export type SetVerdict = { legal: true; winner: Side } | { legal: false; reason: string };

/** Points a set is played to: 21, or 15 for the deciding third set of a best-of-three. */
export function setTarget(setNumber: number, bestOf: BestOf): number {
  return bestOf === 3 && setNumber === 3 ? DECIDING_SET_TARGET : SET_TARGET;
}

/**
 * A completed set: someone reached the target, won by two, and once past the target the
 * margin is exactly two (deuce play, no cap).
 */
export function judgeSet(teamAPoints: number, teamBPoints: number, target: number): SetVerdict {
  if (!Number.isInteger(teamAPoints) || !Number.isInteger(teamBPoints) || teamAPoints < 0 || teamBPoints < 0) {
    return { legal: false, reason: 'Points must be non-negative whole numbers.' };
  }
  const hi = Math.max(teamAPoints, teamBPoints);
  const lo = Math.min(teamAPoints, teamBPoints);
  if (hi < target) {
    return { legal: false, reason: `A set is played to ${target}; ${hi}–${lo} is not finished.` };
  }
  if (hi - lo < WIN_BY) {
    return { legal: false, reason: `Sets are won by ${WIN_BY}; ${hi}–${lo} is not a finished set.` };
  }
  if (hi > target && hi - lo !== WIN_BY) {
    return {
      legal: false,
      reason: `Past ${target} a set ends the moment one side leads by ${WIN_BY}; ${hi}–${lo} cannot happen.`,
    };
  }
  return { legal: true, winner: teamAPoints > teamBPoints ? 'a' : 'b' };
}

export type MatchVerdict =
  | { legal: true; winner: Side; setsWon: { a: number; b: number } }
  | { legal: false; reason: string };

/**
 * Validate a full scoreline against best-of-one or best-of-three rules. Sets must be
 * numbered 1..n contiguously, each set legal for its target, and the match must end
 * exactly when one side reaches the required set count.
 */
export function judgeMatch(sets: readonly SetScore[], bestOf: BestOf): MatchVerdict {
  const needed = bestOf === 3 ? 2 : 1;
  const maxSets = bestOf;
  if (sets.length === 0) return { legal: false, reason: 'A scoreline needs at least one set.' };
  if (sets.length > maxSets) {
    return { legal: false, reason: `A best-of-${bestOf} match has at most ${maxSets} set(s).` };
  }

  const ordered = [...sets].sort((x, y) => x.setNumber - y.setNumber);
  let won = { a: 0, b: 0 };
  for (let i = 0; i < ordered.length; i += 1) {
    const set = ordered[i];
    if (set === undefined) return { legal: false, reason: 'Missing set.' };
    if (set.setNumber !== i + 1) {
      return { legal: false, reason: `Sets must be numbered in order; expected set ${i + 1}, got ${set.setNumber}.` };
    }
    if (won.a === needed || won.b === needed) {
      return { legal: false, reason: `The match was already decided before set ${set.setNumber}.` };
    }
    const verdict = judgeSet(set.teamAPoints, set.teamBPoints, setTarget(set.setNumber, bestOf));
    if (!verdict.legal) return { legal: false, reason: `Set ${set.setNumber}: ${verdict.reason}` };
    won = verdict.winner === 'a' ? { a: won.a + 1, b: won.b } : { a: won.a, b: won.b + 1 };
  }
  if (won.a === needed) return { legal: true, winner: 'a', setsWon: won };
  if (won.b === needed) return { legal: true, winner: 'b', setsWon: won };
  return { legal: false, reason: `Nobody has won ${needed} set(s) yet; the match is not finished.` };
}

/**
 * Canonical form: sets ordered by number, always oriented from team A's side, keys in a
 * fixed order, no whitespace. Two honest submissions of the same result, one typed by
 * each team, produce byte-identical output.
 *
 * `perspective` says which team the submitter typed as "us": a team-B submitter enters
 * their own points first, and canonicalization flips them back.
 */
export function canonicalizeScoreline(scoreline: Scoreline, perspective: Side = 'a'): string {
  const parsed = scorelineSchema.parse(scoreline);
  const sets = [...parsed.sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => {
      const a = perspective === 'a' ? s.teamAPoints : s.teamBPoints;
      const b = perspective === 'a' ? s.teamBPoints : s.teamAPoints;
      return `[${s.setNumber},${a},${b}]`;
    });
  return `{"matchId":${JSON.stringify(parsed.matchId)},"sets":[${sets.join(',')}]}`;
}

/** sha256 hex of the canonical scoreline; agreement between two submissions is equality of this. */
export function hashScoreline(scoreline: Scoreline, perspective: Side = 'a'): string {
  return createHash('sha256').update(canonicalizeScoreline(scoreline, perspective)).digest('hex');
}

/** Human-readable "21–18, 19–21, 15–12" from team A's side. */
export function formatSets(sets: ReadonlyArray<Pick<SetScore, 'setNumber' | 'teamAPoints' | 'teamBPoints'>>): string {
  return [...sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => `${s.teamAPoints}–${s.teamBPoints}`)
    .join(', ');
}
