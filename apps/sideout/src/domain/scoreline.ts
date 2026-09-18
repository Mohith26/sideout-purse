import type { BestOf } from '../db/schema';

/**
 * Beach volleyball scoreline rules (system spec 5.2, rule 3): sets to 21, the deciding
 * set to 15, win by two, best of one or three. Pure functions, no I/O. The seed uses them
 * so every seeded result is a legal one; phase 7 builds the consensus state machine (the
 * canonical form and hash of rule 1) on top of them.
 */

export const SET_TARGET = 21;
export const DECIDING_SET_TARGET = 15;
export const WIN_BY = 2;

export type Side = 'a' | 'b';

export type SetScore = { setNumber: number; teamAPoints: number; teamBPoints: number };

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
