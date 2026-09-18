import { requireUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { joinTeam } from '../../../../../server/teams';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Accept a partner invite: the signed-in user's phone must be the one the captain named. */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const now = new Date();
    const user = await requireUser(request, { db, sessionSecret: env.sessionSecret, now });
    const { id } = await context.params;
    const { team, members } = await joinTeam(db, id, user, now);
    return ok({
      team: { id: team.id, tournamentId: team.tournamentId, name: team.name, status: team.status },
      members: members.map((m) => ({ userId: m.userId, role: m.role })),
    });
  });
}
