import type { PrizeStructure } from '@purse/types';

/**
 * The ladder rules, pure: no database, no clock, no randomness. The services apply them
 * under the season's row lock; `test/domain/ladder.test.ts` is the case table.
 *
 * A ladder is an ordering of the season's entrants, rank 1 at the top. New entrants join
 * at the bottom. A player may challenge anyone up to `CHALLENGE_REACH` places above them
 * (the classic office rule: you climb by beating the people just ahead of you, so a
 * newcomer cannot jump straight to the top). Each player has at most one open challenge
 * at a time. A match is one game to 11 (or more), won by two clear points. When the
 * challenger wins they take the defender's place and everyone from the defender down to
 * the place just above the challenger's old one moves down one; when the defender wins,
 * nothing moves. Either way the result counts on both records.
 *
 * What the ladder tells Purse (the season is one Purse contest; docs/second-tenant.md):
 * every entrant stakes `SEASON_ENTRY_POINTS`; while the season runs, a confirmed result
 * pushes each player's *running* score, their wins so far, with `attemptFinished: false`
 * (Purse lets an unfinished attempt be superseded); at the close every entrant's *final*
 * score is their rank turned upside down (`finalScore`), `attemptFinished: true`, so
 * Purse's ranking (score descending) reproduces the ladder and the prize split follows it.
 */

export type LadderEntry = { playerId: string; rank: number; wins: number; losses: number };

export const CHALLENGE_REACH = 3;

/** Games are to 11, win by two; a long deuce game can run higher, but not absurdly so. */
export const GAME_TO = 11;
export const MAX_GAME_POINTS = 99;

/** The stake every entrant puts up, in POINTS: the free-to-play asset (decision D3). */
export const SEASON_ENTRY_POINTS = 100n;
/** POINTS granted when a player's Purse account is linked, so the entry is affordable ten times over. */
export const WELCOME_POINTS = 1000n;
export const PURSE_ASSET = 'POINTS' as const;

/** The season's prize split: the top three share the pool 50/30/20 (weights, so a smaller field still pays out the whole pool). */
export const SEASON_PRIZE_STRUCTURE: PrizeStructure = { type: 'percentage_split', percentages: [50, 30, 20] };

export type ChallengeRefusal =
  | { ok: false; reason: 'self'; message: string }
  | { ok: false; reason: 'not_on_ladder'; message: string }
  | { ok: false; reason: 'not_above'; message: string }
  | { ok: false; reason: 'out_of_reach'; message: string }
  | { ok: false; reason: 'busy'; message: string };

export type ChallengeJudgement = { ok: true } | ChallengeRefusal;

/** Whether `challengerId` may challenge `defenderId` on this ladder, given the matches still open. */
export function judgeChallenge(ladder: readonly LadderEntry[], challengerId: string, defenderId: string, openMatches: ReadonlyArray<{ challengerId: string; defenderId: string }>): ChallengeJudgement {
  if (challengerId === defenderId) return { ok: false, reason: 'self', message: 'You cannot challenge yourself.' };
  const challenger = ladder.find((e) => e.playerId === challengerId);
  const defender = ladder.find((e) => e.playerId === defenderId);
  if (challenger === undefined || defender === undefined) return { ok: false, reason: 'not_on_ladder', message: 'Both players must be on the ladder.' };
  if (defender.rank >= challenger.rank) return { ok: false, reason: 'not_above', message: 'You can only challenge someone above you.' };
  if (challenger.rank - defender.rank > CHALLENGE_REACH) {
    return { ok: false, reason: 'out_of_reach', message: `You can challenge at most ${CHALLENGE_REACH} places up.` };
  }
  const busy = openMatches.find((m) => m.challengerId === challengerId || m.defenderId === challengerId || m.challengerId === defenderId || m.defenderId === defenderId);
  if (busy !== undefined) {
    const who = busy.challengerId === challengerId || busy.defenderId === challengerId ? 'You already have' : 'They already have';
    return { ok: false, reason: 'busy', message: `${who} an open challenge; play it first.` };
  }
  return { ok: true };
}

export type Scoreline = { challenger: number; defender: number };
export type Winner = 'challenger' | 'defender';

export type ScorelineJudgement = { ok: true; winner: Winner } | { ok: false; message: string };

/** One game to 11, won by two; the scores decide the winner, never a separate claim. */
export function judgeScoreline(score: Scoreline): ScorelineJudgement {
  const { challenger, defender } = score;
  if (!Number.isInteger(challenger) || !Number.isInteger(defender) || challenger < 0 || defender < 0) return { ok: false, message: 'Scores are whole numbers.' };
  if (challenger > MAX_GAME_POINTS || defender > MAX_GAME_POINTS) return { ok: false, message: `Nobody scores more than ${MAX_GAME_POINTS} in a game.` };
  if (challenger === defender) return { ok: false, message: 'A game cannot end level.' };
  const high = Math.max(challenger, defender);
  const low = Math.min(challenger, defender);
  if (high < GAME_TO) return { ok: false, message: `A game is played to ${GAME_TO}.` };
  if (high - low < 2) return { ok: false, message: 'A game is won by two clear points.' };
  if (high > GAME_TO && high - low !== 2) return { ok: false, message: `Past ${GAME_TO}, a game ends the moment someone leads by two.` };
  return { ok: true, winner: challenger > defender ? 'challenger' : 'defender' };
}

export type AppliedResult = { ladder: LadderEntry[]; moved: boolean; winnerId: string; loserId: string };

/**
 * The ladder after a confirmed result. A challenger's win takes the defender's place and
 * shifts everyone in between down one; a defender's win moves nobody. Records update
 * either way. Returns a new array sorted by rank; the input is not mutated.
 */
export function applyResult(ladder: readonly LadderEntry[], match: { challengerId: string; defenderId: string; winner: Winner }): AppliedResult {
  const challenger = ladder.find((e) => e.playerId === match.challengerId);
  const defender = ladder.find((e) => e.playerId === match.defenderId);
  if (challenger === undefined || defender === undefined) throw new RangeError('both players must be on the ladder');
  if (defender.rank >= challenger.rank) throw new RangeError('the defender must be above the challenger');
  const winnerId = match.winner === 'challenger' ? challenger.playerId : defender.playerId;
  const loserId = match.winner === 'challenger' ? defender.playerId : challenger.playerId;
  const moved = match.winner === 'challenger';
  const next = ladder.map((entry): LadderEntry => {
    let rank = entry.rank;
    if (moved) {
      if (entry.playerId === challenger.playerId) rank = defender.rank;
      else if (entry.rank >= defender.rank && entry.rank < challenger.rank) rank = entry.rank + 1;
    }
    return {
      ...entry,
      rank,
      wins: entry.playerId === winnerId ? entry.wins + 1 : entry.wins,
      losses: entry.playerId === loserId ? entry.losses + 1 : entry.losses,
    };
  });
  return { ladder: sortLadder(next), moved, winnerId, loserId };
}

export function sortLadder(ladder: readonly LadderEntry[]): LadderEntry[] {
  return [...ladder].sort((x, y) => x.rank - y.rank || (x.playerId < y.playerId ? -1 : 1));
}

/** A ladder is well formed when its ranks are exactly 1..n. */
export function assertGapless(ladder: readonly LadderEntry[]): void {
  const ranks = sortLadder(ladder).map((e) => e.rank);
  ranks.forEach((rank, index) => {
    if (rank !== index + 1) throw new RangeError(`ladder ranks are not 1..${ranks.length}: ${ranks.join(',')}`);
  });
}

/** A running score: wins so far. */
export function runningScore(wins: number): number {
  if (!Number.isInteger(wins) || wins < 0) throw new RangeError(`wins must be a non-negative integer, got ${wins}`);
  return wins;
}

/** A final score from a rank among `count` entrants: the top scores `count`, the bottom 1. Strictly decreasing in rank. */
export function finalScore(rank: number, count: number): number {
  if (!Number.isInteger(rank) || rank < 1 || rank > count) throw new RangeError(`rank ${rank} is not within 1..${count}`);
  return count - rank + 1;
}

/** Every entrant's final score from the ladder. */
export function finalScores(ladder: readonly LadderEntry[]): Map<string, number> {
  assertGapless(ladder);
  return new Map(ladder.map((e) => [e.playerId, finalScore(e.rank, ladder.length)]));
}

/** The name key a sign-in name normalises to; two spellings of one name are one player. */
export function nameKeyOf(name: string): string | null {
  const key = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return key.length === 0 ? null : key;
}
