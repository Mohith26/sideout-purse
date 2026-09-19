import { asc, eq } from 'drizzle-orm';

import { POST as draw } from '../../src/app/api/admin/tournaments/[id]/draw/route';
import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { POST as submitScores } from '../../src/app/api/matches/[id]/scores/route';
import { matches, teamMembers, users, type Charity, type User } from '../../src/db/schema';
import { registerTeams, tournamentBody } from '../api/fixtures';
import { cookieFor, data, params, request, type Database } from '../helpers';

/**
 * A live single-elimination tournament of four teams with its bracket drawn, built through
 * the same routes the app uses, with Purse unconfigured (the mirror reports `skipped`, the
 * push `unavailable`; neither is fatal). Every round-1 match has both teams and a captain
 * to submit for each.
 */
export type LiveFixture = { id: string; slug: string; roundOne: Array<{ id: string; teamAId: string; teamBId: string }>; captainOf: (teamId: string) => User };

export async function liveTournament(database: Database, organizer: User, charity: Charity, slug = 'live-fixture'): Promise<LiveFixture> {
  const cookie = cookieFor(organizer);
  const patch = async (id: string, body: Record<string, unknown>) => data(await patchTournament(request('PATCH', '/x', { body, cookie }), params({ id })));
  const { tournament } = await data<{ tournament: { id: string; slug: string } }>(
    await createTournament(request('POST', '/x', { body: tournamentBody(charity, { slug, name: `Live ${slug}`, format: 'single_elim', maxTeams: 4, entryDonationCents: '0' }), cookie })),
  );
  await patch(tournament.id, { status: 'registration_open' });
  const teamIds = await registerTeams(database, tournament.id, 4, { 0: 1, 1: 2, 2: 3, 3: 4 });
  const captains = new Map<string, User>();
  for (const teamId of teamIds) {
    const [row] = await database.db.select({ user: users }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).where(eq(teamMembers.teamId, teamId)).orderBy(asc(teamMembers.role));
    if (row === undefined) throw new Error('team without members');
    captains.set(teamId, row.user);
  }
  await patch(tournament.id, { status: 'registration_closed' });
  await data(await draw(request('POST', '/x', { body: { stage: 'bracket', courts: 2, rngSeed: 3 }, cookie }), params({ id: tournament.id })));
  await patch(tournament.id, { status: 'live' });
  const rows = await database.db.select().from(matches).where(eq(matches.tournamentId, tournament.id)).orderBy(asc(matches.bracketPosition));
  const roundOne = rows.filter((m) => m.round === 1 && m.teamAId !== null && m.teamBId !== null).map((m) => ({ id: m.id, teamAId: m.teamAId ?? '', teamBId: m.teamBId ?? '' }));
  return {
    ...tournament,
    roundOne,
    captainOf: (teamId) => {
      const captain = captains.get(teamId);
      if (captain === undefined) throw new Error(`no captain for ${teamId}`);
      return captain;
    },
  };
}

export const WIN = [
  { setNumber: 1, usPoints: 21, themPoints: 18 },
  { setNumber: 2, usPoints: 21, themPoints: 15 },
];

export function submit(matchId: string, user: User, sets: Array<{ setNumber: number; usPoints: number; themPoints: number }> = WIN): Promise<Response> {
  return submitScores(request('POST', '/x', { body: { sets }, cookie: cookieFor(user) }), params({ id: matchId }));
}
