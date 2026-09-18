import { and, desc, eq, ne } from 'drizzle-orm';

import { donations, teamMembers, teams, tournaments, users, type User } from '../db/schema';
import type { DbOrTx } from './db';
import { centsToJson } from './money';
import { toPublicProfile, toPublicTeam, type PublicProfile, type PublicTeam } from './public-shape';
import { teamMembersWithUsers } from './teams';

export type MeSnapshot = {
  user: PublicProfile;
  teams: Array<{ team: PublicTeam; tournament: { id: string; slug: string; name: string; status: string; startsAt: string } }>;
  /** Teams that invited this user's phone number and are still waiting on them. */
  invites: Array<{ teamId: string; teamName: string; captain: string; tournament: { id: string; slug: string; name: string; status: string } }>;
  donations: Array<{ id: string; tournamentSlug: string; amountCents: string; currency: string; status: string; at: string }>;
};

export async function meSnapshot(db: DbOrTx, user: User): Promise<MeSnapshot> {
  const myTeams = await db
    .select({ team: teams, tournament: tournaments })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
    .where(eq(teamMembers.userId, user.id))
    .orderBy(desc(tournaments.startsAt));
  const members = await teamMembersWithUsers(db, myTeams.map((t) => t.team.id));

  const myTeamIds = myTeams.map((t) => t.team.id);
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
    .select({ donation: donations, slug: tournaments.slug })
    .from(donations)
    .innerJoin(tournaments, eq(tournaments.id, donations.tournamentId))
    .where(eq(donations.userId, user.id))
    .orderBy(desc(donations.createdAt));

  return {
    user: toPublicProfile(user),
    teams: myTeams.map(({ team, tournament }) => ({
      team: toPublicTeam(team, members.filter((m) => m.member.teamId === team.id)),
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
    donations: myDonations.map(({ donation, slug }) => ({
      id: donation.id,
      tournamentSlug: slug,
      amountCents: centsToJson(donation.amountCents),
      currency: donation.currency,
      status: donation.status,
      at: donation.createdAt.toISOString(),
    })),
  };
}
