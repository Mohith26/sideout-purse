import { requireUser } from '../../../server/auth/current-user';
import { appContext } from '../../../server/context';
import { parseJsonBody } from '../../../server/http/input';
import { handle, ok } from '../../../server/http/respond';
import { createTeam, createTeamSchema } from '../../../server/teams';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Create a team in an open tournament and invite a partner by phone number. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const now = new Date();
    const user = await requireUser(request, { db, sessionSecret: env.sessionSecret, now });
    const body = await parseJsonBody(request, createTeamSchema);
    const { team, members } = await createTeam(db, body, user, now);
    return ok(
      {
        team: { id: team.id, tournamentId: team.tournamentId, name: team.name, status: team.status, invitedPhone: team.invitedPhoneE164 },
        members: members.map((m) => ({ userId: m.userId, role: m.role })),
      },
      { status: 201 },
    );
  });
}
