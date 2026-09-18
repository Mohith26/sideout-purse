import type { PrizeStructure } from '@purse/types';

import type { FinalPlacement } from './final-standings';
import { TEAM_SIZE } from './team';

/**
 * What Sideout tells Purse about a tournament, expressed in Purse's terms: a contest with
 * one entry stake per player, a prize structure, and one numeric score per player that
 * Purse ranks descending to settle. Pure; `docs/decisions.md` (phase 7) records the
 * reasoning.
 *
 * The score a player carries in Purse:
 *
 * - While the tournament runs, every agreed match pushes each player's *running* score,
 *   their team's match wins so far, with `attemptFinished: false`. Purse lets an
 *   unfinished attempt be superseded, so the next agreed match simply advances it.
 * - Once every match is complete, Sideout pushes each player's *final* score, derived
 *   from the tournament's final standings so that a better placement is a strictly higher
 *   score and tied teams share one, with `attemptFinished: true`: a finished attempt is
 *   final in Purse, which is exactly what a settled outcome should be. Purse then holds
 *   every expected result and moves to `awaiting_settlement` on its own.
 */

/** The stake every player puts up, in POINTS: the free-to-play asset (decision D3). */
export const PURSE_ENTRY_POINTS = 100n;
/** POINTS granted to a player when their Purse account is linked, so the free entry is affordable ten times over. */
export const PURSE_WELCOME_POINTS = 1000n;
export const PURSE_ASSET = 'POINTS' as const;

/** A running score: match wins so far. */
export function runningScore(wins: number): number {
  if (!Number.isInteger(wins) || wins < 0) throw new RangeError(`wins must be a non-negative integer, got ${wins}`);
  return wins;
}

/**
 * A final score from a placement among `teamCount` teams: first place scores `teamCount`,
 * last place scores 1, tied placements score the same. Strictly decreasing in placement,
 * so Purse's ranking (score descending, ties shared) reproduces Sideout's standings.
 */
export function finalScore(placement: number, teamCount: number): number {
  if (!Number.isInteger(placement) || placement < 1 || placement > teamCount) throw new RangeError(`placement ${placement} is not within 1..${teamCount}`);
  return teamCount - placement + 1;
}

/** Every team's final score from the standings. */
export function finalScores(placements: readonly FinalPlacement[]): Map<string, number> {
  const count = placements.length;
  return new Map(placements.map((p) => [p.teamId, finalScore(p.placement, count)]));
}

/**
 * The prize structure a tournament's sponsors imply. Sponsor prize contributions are real
 * dollars put up for goods, and they never enter Purse (spec 4.2.6); what they shape is
 * the *split*: sorted largest first they become a placement table whose amounts Purse
 * treats as weights over the escrowed pool, so the presenting sponsor's prize is first
 * place's share, the next contribution second place's, and so on. A tournament with no
 * contributions (or only empty ones) splits 50/30/20, the spec's own example.
 *
 * Purse places players, and the two players of a team always tie, sharing the combined
 * prize of the placements they occupy (`split_evenly`). So every team-level share is laid
 * out as two player-level placements of the same weight: a 50/30/20 split of teams is
 * 50/50/30/30/20/20 of players, and the champions (tied first) share the two 50s, half
 * the pool, between them.
 */
export const DEFAULT_TEAM_SHARES: readonly bigint[] = [50n, 30n, 20n];

export function prizeStructureFor(contributions: ReadonlyArray<{ prizeContributionCents: bigint }>): PrizeStructure {
  const amounts = contributions
    .map((s) => s.prizeContributionCents)
    .filter((cents) => cents > 0n)
    .sort((x, y) => (x === y ? 0 : x > y ? -1 : 1));
  const teamShares = amounts.length === 0 ? DEFAULT_TEAM_SHARES : amounts;
  const playerShares = teamShares.flatMap((share) => Array.from({ length: TEAM_SIZE }, () => share));
  return { type: 'placement_table', placements: playerShares.map((amount, index) => ({ placement: index + 1, amount: amount.toString() })) };
}

/** The structure a tournament with no sponsor contributions gets. */
export const DEFAULT_PRIZE_STRUCTURE: PrizeStructure = prizeStructureFor([]);
