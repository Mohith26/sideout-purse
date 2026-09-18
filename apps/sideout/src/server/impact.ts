import { asc, desc, eq } from 'drizzle-orm';

import { charities, donations, sponsors, teams, users, type Charity, type Donation, type Tournament } from '../db/schema';
import type { DbOrTx } from './db';
import { donationTotals, recentDonors } from './donations/service';
import type { ReservationClock } from './field';
import { centsToJson, DONATION_CURRENCY, percentOf } from './money';
import { toPublicSponsor, type PublicSponsor, type PublicTournament } from './public-shape';
import { listTournamentSummaries } from './screens';

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

// ---- The Impact screens (spec 5.3: raised vs goal, donors, sponsors) ----------------------------

export type DonorWallEntry = {
  id: string;
  /** A team's entry donation, a named supporter's gift, or one given without a name. */
  kind: 'team_entry' | 'supporter' | 'anonymous';
  label: string;
  amountCents: string;
  currency: string;
  at: string;
};

export type ImpactBreakdown = {
  raisedCents: string;
  goalCents: string;
  progressPercent: number;
  donorCount: number;
  /** Succeeded team entry donations. */
  entryCents: string;
  entryCount: number;
  /** Succeeded supporter gifts (no team). */
  supporterCents: string;
  supporterCount: number;
  /** Pending donations: not yet counted. */
  pendingCents: string;
  currency: string;
};

export type TournamentImpactDetail = {
  breakdown: ImpactBreakdown;
  donorWall: DonorWallEntry[];
  sponsors: PublicSponsor[];
  /** The sponsor prize pool: a separate ledger from donations, never counted toward the goal. */
  sponsorPrizeCents: string;
};

/** Everything the Impact tab shows, from `donations` and `sponsors` rows; nothing here touches contest value. */
export async function tournamentImpactDetail(db: DbOrTx, tournament: Tournament): Promise<TournamentImpactDetail> {
  const rows = await db
    .select({ donation: donations, teamName: teams.name, donorName: users.displayName })
    .from(donations)
    .leftJoin(teams, eq(teams.id, donations.teamId))
    .leftJoin(users, eq(users.id, donations.userId))
    .where(eq(donations.tournamentId, tournament.id))
    .orderBy(desc(donations.updatedAt), desc(donations.id));
  const succeeded = rows.filter((r) => r.donation.status === 'succeeded');
  const net = (d: Donation): bigint => d.amountCents - d.refundedCents;
  const entries = succeeded.filter((r) => r.donation.teamId !== null);
  const supporters = succeeded.filter((r) => r.donation.teamId === null);
  const raised = succeeded.reduce((total, r) => total + net(r.donation), 0n);
  const pending = rows.filter((r) => r.donation.status === 'pending').reduce((total, r) => total + r.donation.amountCents, 0n);
  const currency = rows[0]?.donation.currency ?? DONATION_CURRENCY;
  const sponsorRows = await db.select().from(sponsors).where(eq(sponsors.tournamentId, tournament.id)).orderBy(asc(sponsors.createdAt));
  return {
    breakdown: {
      raisedCents: centsToJson(raised),
      goalCents: centsToJson(tournament.fundraisingGoalCents),
      progressPercent: percentOf(raised, tournament.fundraisingGoalCents),
      donorCount: succeeded.length,
      entryCents: centsToJson(entries.reduce((total, r) => total + net(r.donation), 0n)),
      entryCount: entries.length,
      supporterCents: centsToJson(supporters.reduce((total, r) => total + net(r.donation), 0n)),
      supporterCount: supporters.length,
      pendingCents: centsToJson(pending),
      currency,
    },
    donorWall: succeeded.map((r) => ({
      id: r.donation.id,
      kind: r.donation.teamId !== null ? 'team_entry' : r.donorName !== null ? 'supporter' : 'anonymous',
      label: r.donation.teamId !== null ? (r.teamName ?? 'A team') : (r.donorName ?? 'Anonymous'),
      amountCents: centsToJson(net(r.donation)),
      currency: r.donation.currency,
      at: r.donation.updatedAt.toISOString(),
    })),
    sponsors: sponsorRows.map(toPublicSponsor),
    sponsorPrizeCents: centsToJson(sponsorRows.reduce((total, s) => total + s.prizeContributionCents, 0n)),
  };
}

export type GlobalImpact = {
  charity: Charity | null;
  totalRaisedCents: string;
  totalGoalCents: string;
  progressPercent: number;
  donorCount: number;
  currency: string;
  perEvent: Array<{ tournament: PublicTournament; raisedCents: string; donorCount: number; progressPercent: number }>;
};

/** Every non-draft event's raised total, and the sum across them; the beneficiary is the active charity when there is one. */
export async function globalImpact(db: DbOrTx, clock: ReservationClock): Promise<GlobalImpact> {
  const summaries = await listTournamentSummaries(db, clock);
  const [charity] = await db.select().from(charities).where(eq(charities.status, 'active')).orderBy(asc(charities.createdAt)).limit(1);
  const totalRaised = summaries.reduce((total, s) => total + BigInt(s.raisedCents), 0n);
  const totalGoal = summaries.reduce((total, s) => total + BigInt(s.tournament.fundraisingGoalCents), 0n);
  return {
    charity: charity ?? null,
    totalRaisedCents: centsToJson(totalRaised),
    totalGoalCents: centsToJson(totalGoal),
    progressPercent: percentOf(totalRaised, totalGoal),
    donorCount: summaries.reduce((total, s) => total + s.donorCount, 0),
    currency: summaries[0]?.currency ?? DONATION_CURRENCY,
    perEvent: summaries.map((s) => ({ tournament: s.tournament, raisedCents: s.raisedCents, donorCount: s.donorCount, progressPercent: percentOf(BigInt(s.raisedCents), BigInt(s.tournament.fundraisingGoalCents)) })),
  };
}
