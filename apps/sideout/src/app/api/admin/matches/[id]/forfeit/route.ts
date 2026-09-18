import { actorFor } from '../../../../../../server/actor';
import { requireOrganizer } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import type { RouteContext } from '../../../../../../server/http/input';
import { parseJsonBody } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { forfeitMatch, forfeitSchema } from '../../../../../../server/matches';
import { toPublicMatch } from '../../../../../../server/public-shape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Record a forfeit: the other team wins and, in a bracket, advances. Organizers only. */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, forfeitSchema);
    const result = await forfeitMatch(db, { matchId: id, forfeitingTeamId: body.forfeitingTeamId, actor: actorFor(organizer), now });
    return ok({ match: toPublicMatch(result.match, []), winnerTeamId: result.winnerTeamId, advancedTo: result.advancedTo });
  });
}
