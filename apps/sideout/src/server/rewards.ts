import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { teamMembers, teams, tournaments, type User } from '../db/schema';
import type { DbOrTx } from './db';

/**
 * A player's rewards, read off what Purse settled: every settled event the player's team
 * placed in, with the placement Sideout pushed and the payout Purse's frozen close preview
 * held for the player (the close confirms exactly that preview's hash, so it is the
 * settled amount). Contest value is Purse's; this shows what Purse said, never a figure
 * Sideout holds (docs/decisions.md, phase 7), and the live wallet is read from Purse.
 */
export type RewardRow = {
  tournamentId: string;
  tournamentSlug: string;
  tournamentName: string;
  teamId: string;
  teamName: string;
  placement: number;
  /** POINTS as Purse paid them, or null when Purse held no entry for this player. */
  payout: string | null;
  settledAt: string;
};

export async function rewardsFor(db: DbOrTx, user: User): Promise<RewardRow[]> {
  const rows = await db
    .select({ tournament: tournaments, team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
    .where(and(eq(teamMembers.userId, user.id), eq(tournaments.status, 'settled'), isNotNull(tournaments.purseClosePreview)))
    .orderBy(desc(tournaments.startsAt));
  return rows.flatMap(({ tournament, team }) => {
    const frozen = tournament.purseClosePreview;
    if (frozen === null) return [];
    const placement = frozen.standings.find((s) => s.teamId === team.id);
    if (placement === undefined) return [];
    const payout = user.purseUserId === null ? null : (frozen.payouts.find((p) => p.userId === user.purseUserId)?.payout ?? null);
    return [{ tournamentId: tournament.id, tournamentSlug: tournament.slug, tournamentName: tournament.name, teamId: team.id, teamName: team.name, placement: placement.placement, payout, settledAt: frozen.previewedAt }];
  });
}
