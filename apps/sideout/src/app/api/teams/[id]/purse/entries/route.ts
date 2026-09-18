import { and, asc, eq } from 'drizzle-orm';

import { purseEntries, teamMembers, teams, tournaments, users } from '../../../../../../db/schema';
import { requireUser } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import { failure } from '../../../../../../server/http/errors';
import type { RouteContext } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { purseFailureToApi, readBackEntries } from '../../../../../../server/purse/contests';
import { requirePurse } from '../../../../../../server/purse/deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PlayerEntry = { userId: string; displayName: string; role: string; linked: boolean; entered: boolean };

async function teamEntries(id: string, userId: string): Promise<{ tournamentId: string; teamId: string; players: PlayerEntry[]; complete: boolean }> {
  const { db } = appContext();
  const [team] = await db.select().from(teams).where(eq(teams.id, id));
  if (team === undefined) throw failure.notFound('team_not_found', 'No such team.');
  const members = await db
    .select({ userId: users.id, displayName: users.displayName, role: teamMembers.role, purseUserId: users.purseUserId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, team.id))
    .orderBy(asc(teamMembers.role), asc(teamMembers.createdAt));
  if (!members.some((m) => m.userId === userId)) throw failure.permission('not_on_team', 'Only a member of the team can see its entries.');
  const held = await db.select().from(purseEntries).where(and(eq(purseEntries.tournamentId, team.tournamentId), eq(purseEntries.state, 'entered')));
  const enteredUsers = new Set(held.map((h) => h.userId).filter((u): u is string => u !== null));
  const players = members.map((m) => ({ userId: m.userId, displayName: m.displayName, role: m.role, linked: m.purseUserId !== null, entered: enteredUsers.has(m.userId) }));
  return { tournamentId: team.tournamentId, teamId: team.id, players, complete: players.length > 0 && players.every((p) => p.entered) };
}

/** What Sideout has recorded of the team's Purse entries. Members only. */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const user = await requireUser(request, { db, sessionSecret: env.sessionSecret, now: new Date() });
    const { id } = await context.params;
    return ok(await teamEntries(id, user.id));
  });
}

/** Read the contest's entrants back from Purse and record both players' entries: the check after each player's entry flow completes. Members only. */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const before = await teamEntries(id, user.id);
    const [tournament] = await app.db.select().from(tournaments).where(eq(tournaments.id, before.tournamentId));
    if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
    try {
      await readBackEntries(requirePurse(app), tournament, { requestId, now });
    } catch (error) {
      return purseFailureToApi(error);
    }
    return ok(await teamEntries(id, user.id));
  });
}
