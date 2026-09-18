import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { donations, teamMembers, teams, tournaments, users, type User } from '../db/schema';
import type { DbOrTx } from './db';
import { holdsPlace, placeHoldingDonation, reservationExpiresAt, type ReservationClock } from './field';
import { centsToJson } from './money';
import { toPublicProfile, toPublicTeam, type PublicProfile, type PublicTeam } from './public-shape';
import { teamMembersWithUsers } from './teams';

/**
 * A team or donation's standing under the lazy-expiry rule capacity uses: whether it holds
 * a place right now, and when a still-pending reservation lapses (null once paid, free, or
 * with nothing pending).
 */
export type PlaceState = { holdsPlace: boolean; reservationExpiresAt: string | null };

export type MeSnapshot = {
  user: PublicProfile;
  teams: Array<{ team: PublicTeam & PlaceState; tournament: { id: string; slug: string; name: string; status: string; startsAt: string } }>;
  /** Teams that invited this user's phone number and are still waiting on them. */
  invites: Array<{ teamId: string; teamName: string; captain: string; tournament: { id: string; slug: string; name: string; status: string } }>;
  donations: Array<{ id: string; tournamentSlug: string; amountCents: string; currency: string; status: string; lastPaymentError: string | null; at: string } & PlaceState>;
};

export async function meSnapshot(db: DbOrTx, user: User, clock: ReservationClock): Promise<MeSnapshot> {
  const myTeams = await db
    .select({ team: teams, tournament: tournaments, holdsPlace: holdsPlace(clock) })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
    .where(eq(teamMembers.userId, user.id))
    .orderBy(desc(tournaments.startsAt));
  const members = await teamMembersWithUsers(db, myTeams.map((t) => t.team.id));
  const teamDonations =
    myTeams.length === 0
      ? []
      : await db
          .select({ teamId: donations.teamId, status: donations.status, createdAt: donations.createdAt })
          .from(donations)
          .where(inArray(donations.teamId, myTeams.map((t) => t.team.id)));
  const teamReservationExpiry = (teamId: string): string | null => {
    const own = teamDonations.filter((d) => d.teamId === teamId);
    if (own.some((d) => d.status === 'succeeded')) return null;
    const pending = own.filter((d) => d.status === 'pending').sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
    return pending === undefined ? null : reservationExpiresAt(pending, clock).toISOString();
  };

  const myTeamIds = myTeams.map((t) => t.team.id);
  const teamHolds = new Map(myTeams.map((t) => [t.team.id, t.holdsPlace]));
  const invites =
    user.phoneE164 === null
      ? []
      : await db
          .select({ team: teams, tournament: tournaments, captain: users.displayName })
          .from(teams)
          .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
          .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.role, 'captain')))
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(and(eq(teams.invitedPhoneE164, user.phoneE164), eq(teams.status, 'forming'), ne(tournaments.status, 'draft')));

  const myDonations = await db
    .select({ donation: donations, slug: tournaments.slug, holdsPlace: sql<boolean>`${placeHoldingDonation(clock)}` })
    .from(donations)
    .innerJoin(tournaments, eq(tournaments.id, donations.tournamentId))
    .where(eq(donations.userId, user.id))
    .orderBy(desc(donations.createdAt));

  return {
    user: toPublicProfile(user),
    teams: myTeams.map(({ team, tournament, holdsPlace: holds }) => ({
      team: { ...toPublicTeam(team, members.filter((m) => m.member.teamId === team.id)), holdsPlace: holds, reservationExpiresAt: teamReservationExpiry(team.id) },
      tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name, status: tournament.status, startsAt: tournament.startsAt.toISOString() },
    })),
    invites: invites
      .filter((i) => !myTeamIds.includes(i.team.id))
      .map((i) => ({
        teamId: i.team.id,
        teamName: i.team.name,
        captain: i.captain,
        tournament: { id: i.tournament.id, slug: i.tournament.slug, name: i.tournament.name, status: i.tournament.status },
      })),
    donations: myDonations.map(({ donation, slug, holdsPlace: holds }) => ({
      id: donation.id,
      tournamentSlug: slug,
      amountCents: centsToJson(donation.amountCents),
      currency: donation.currency,
      status: donation.status,
      lastPaymentError: donation.lastPaymentError,
      at: donation.createdAt.toISOString(),
      holdsPlace: holds && donation.teamId !== null && teamHolds.get(donation.teamId) === true,
      reservationExpiresAt: donation.status === 'pending' ? reservationExpiresAt(donation, clock).toISOString() : null,
    })),
  };
}
