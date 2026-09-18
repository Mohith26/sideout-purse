import type { MatchSlot } from '../db/schema';

/**
 * Bracket advancement. `advanceWinner` is the one function that decides where a winner
 * goes next; phase 7's consensus calls it when a match becomes `final`, the organizer
 * forfeit calls it today, and the draw calls it for byes. Pure: it returns the placement
 * and the service writes it.
 */

export type BracketLink = {
  id: string;
  teamAId: string | null;
  teamBId: string | null;
  /** Bracket seeds of the two slots, carried forward so later rounds can show them. */
  teamASeed?: number | null;
  teamBSeed?: number | null;
  nextMatchId: string | null;
  nextMatchSlot: MatchSlot | null;
};

export type Advancement = { fromMatchId: string; nextMatchId: string; slot: MatchSlot; teamId: string; seed: number | null };

export class BracketError extends Error {
  override readonly name = 'BracketError';
  constructor(
    readonly code: 'winner_not_participant' | 'malformed_link',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve the slot a winner advances into, or `null` when the match is the final (no
 * next match). Throws when the winner is not one of the match's teams.
 */
export function advanceWinner(match: BracketLink, winnerTeamId: string): Advancement | null {
  if (winnerTeamId !== match.teamAId && winnerTeamId !== match.teamBId) {
    throw new BracketError('winner_not_participant', `Team ${winnerTeamId} is not playing in match ${match.id}.`);
  }
  if ((match.nextMatchId === null) !== (match.nextMatchSlot === null)) {
    throw new BracketError('malformed_link', `Match ${match.id} has a next match without a slot, or a slot without a match.`);
  }
  if (match.nextMatchId === null || match.nextMatchSlot === null) return null;
  const seed = (winnerTeamId === match.teamAId ? match.teamASeed : match.teamBSeed) ?? null;
  return { fromMatchId: match.id, nextMatchId: match.nextMatchId, slot: match.nextMatchSlot, teamId: winnerTeamId, seed };
}

/** The team that wins when the other forfeits. */
export function forfeitWinner(match: Pick<BracketLink, 'id' | 'teamAId' | 'teamBId'>, forfeitingTeamId: string): string {
  if (forfeitingTeamId === match.teamAId && match.teamBId !== null) return match.teamBId;
  if (forfeitingTeamId === match.teamBId && match.teamAId !== null) return match.teamAId;
  throw new BracketError('winner_not_participant', `Team ${forfeitingTeamId} is not playing in match ${match.id}, or has no opponent to forfeit to.`);
}
