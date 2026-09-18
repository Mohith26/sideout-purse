import { and, eq, inArray, ne } from 'drizzle-orm';
import { newId } from '@repo/ids';
import { z } from 'zod';

import type { Db } from '../db/client';
import { teamMembers, teams, tournaments, users, type Team, type TeamMember, type Tournament, type User } from '../db/schema';
import { assertTeamRoster, TEAM_SIZE } from '../domain/team';
import { actorFor } from './actor';
import { writeAudit } from './audit';
import { phoneE164Schema } from './auth/phone';
import type { DbOrTx } from './db';
import { failure } from './http/errors';

/**
 * Team creation and the partner invite. A captain names their partner by phone number;
 * the partner signs in with that number and joins. Registration (the donation) is a
 * separate step in `registration.ts` and needs the roster complete first.
 */

export const createTeamSchema = z.object({
  tournamentSlug: z.string().min(1),
  name: z.string().trim().min(2).max(60),
  partnerPhone: phoneE164Schema,
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;

/** Teams still in play for a user in a tournament: anything not withdrawn. */
export async function activeTeamFor(db: DbOrTx, tournamentId: string, userId: string): Promise<Team | null> {
  const [row] = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teams.tournamentId, tournamentId), ne(teams.status, 'withdrawn')))
    .limit(1);
  return row?.team ?? null;
}

async function requireOpenTournament(tx: DbOrTx, slug: string): Promise<Tournament> {
  const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.slug, slug));
  if (tournament === undefined || tournament.status === 'draft') throw failure.notFound('tournament_not_found', 'No such tournament.');
  if (tournament.status !== 'registration_open') {
    throw failure.invalidState('registration_not_open', `Registration for ${tournament.name} is ${tournament.status.replace('_', ' ')}.`);
  }
  return tournament;
}

export async function createTeam(db: Db, input: CreateTeamInput, user: User, now: Date): Promise<{ team: Team; members: TeamMember[] }> {
  if (user.phoneE164 !== null && user.phoneE164 === input.partnerPhone) {
    throw failure.invalidRequest('partner_is_self', 'Invite someone other than yourself.');
  }
  return db.transaction(async (tx) => {
    const tournament = await requireOpenTournament(tx, input.tournamentSlug);
    const existing = await activeTeamFor(tx, tournament.id, user.id);
    if (existing !== null) throw failure.conflict('already_on_team', `You are already on ${existing.name} in this tournament.`);

    const [team] = await tx
      .insert(teams)
      .values({
        id: newId('tm'),
        tournamentId: tournament.id,
        name: input.name,
        status: 'forming',
        invitedPhoneE164: input.partnerPhone,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (team === undefined) throw new Error('team insert returned no row');
    const [captain] = await tx
      .insert(teamMembers)
      .values({ id: newId('tmm'), teamId: team.id, userId: user.id, role: 'captain', createdAt: now })
      .returning();
    if (captain === undefined) throw new Error('team member insert returned no row');
    await writeAudit(tx, {
      actor: actorFor(user),
      action: 'team.created',
      subjectType: 'team',
      subjectId: team.id,
      detail: { tournamentId: tournament.id, name: team.name, invitedPhoneE164: input.partnerPhone },
      at: now,
    });
    return { team, members: [captain] };
  });
}

export async function joinTeam(db: Db, teamId: string, user: User, now: Date): Promise<{ team: Team; members: TeamMember[] }> {
  return db.transaction(async (tx) => {
    const [team] = await tx.select().from(teams).where(eq(teams.id, teamId)).for('update');
    if (team === undefined) throw failure.notFound('team_not_found', 'No such team.');
    const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.id, team.tournamentId));
    if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
    if (tournament.status !== 'registration_open') {
      throw failure.invalidState('registration_not_open', `Registration for ${tournament.name} is ${tournament.status.replace('_', ' ')}.`);
    }
    if (team.status !== 'forming') throw failure.invalidState('team_not_forming', `${team.name} is ${team.status}; nobody can join it.`);
    if (user.phoneE164 === null || team.invitedPhoneE164 !== user.phoneE164) {
      throw failure.permission('not_invited', 'This team invited a different phone number.');
    }

    const current = await tx.select().from(teamMembers).where(eq(teamMembers.teamId, team.id));
    if (current.some((m) => m.userId === user.id)) throw failure.conflict('already_member', 'You are already on this team.');
    if (current.length >= TEAM_SIZE) throw failure.invalidState('team_full', `${team.name} already has ${TEAM_SIZE} players.`);
    const elsewhere = await activeTeamFor(tx, tournament.id, user.id);
    if (elsewhere !== null) throw failure.conflict('already_on_team', `You are already on ${elsewhere.name} in this tournament.`);

    const [joined] = await tx
      .insert(teamMembers)
      .values({ id: newId('tmm'), teamId: team.id, userId: user.id, role: 'player', createdAt: now })
      .returning();
    if (joined === undefined) throw new Error('team member insert returned no row');
    const members = [...current, joined];
    assertTeamRoster(members.map((m) => ({ userId: m.userId, role: m.role })));

    await tx.update(teams).set({ updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: actorFor(user),
      action: 'team.member_joined',
      subjectType: 'team',
      subjectId: team.id,
      detail: { userId: user.id, role: 'player' },
      at: now,
    });
    return { team, members };
  });
}

export async function teamMembersWithUsers(db: DbOrTx, teamIds: readonly string[]): Promise<Array<{ member: TeamMember; user: User }>> {
  if (teamIds.length === 0) return [];
  return db
    .select({ member: teamMembers, user: users })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(inArray(teamMembers.teamId, [...teamIds]));
}
