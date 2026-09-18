import type { Tournament } from '../db/schema';
import type { DbOrTx } from './db';
import { donationTotals, recentDonors } from './donations/service';
import { centsToJson, percentOf } from './money';

/**
 * The Impact figures: raised against goal, derived entirely from `donations`. Sponsors
 * are not here, deliberately; they are event metadata on the tournament detail and
 * never summed with donations (spec acceptance criterion 21).
 */
export type Impact = {
  tournamentId: string;
  slug: string;
  raisedCents: string;
  goalCents: string;
  progressPercent: number;
  donationCount: number;
  donors: Array<{ displayName: string | null; amountCents: string; at: string }>;
};

export async function tournamentImpact(db: DbOrTx, tournament: Tournament): Promise<Impact> {
  const totals = await donationTotals(db, tournament.id);
  const donors = await recentDonors(db, tournament.id);
  return {
    tournamentId: tournament.id,
    slug: tournament.slug,
    raisedCents: centsToJson(totals.raisedCents),
    goalCents: centsToJson(tournament.fundraisingGoalCents),
    progressPercent: percentOf(totals.raisedCents, tournament.fundraisingGoalCents),
    donationCount: totals.donationCount,
    donors: donors.map((d) => ({ displayName: d.displayName, amountCents: centsToJson(d.amountCents), at: d.at.toISOString() })),
  };
}
