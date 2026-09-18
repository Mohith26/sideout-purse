import { currentUser } from '../../../../server/auth/current-user';
import { consensusView, viewerSide } from '../../../../server/consensus';
import { appContext } from '../../../../server/context';
import { failure } from '../../../../server/http/errors';
import type { RouteContext } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { matchView } from '../../../../server/matches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One match with its sets, teams and consensus; a signed-in player also learns which side they are on. Matches of draft tournaments are 404. */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const { id } = await context.params;
    const view = await matchView(db, id);
    if (view === null) throw failure.notFound('match_not_found', 'No such match.');
    const user = await currentUser(request, { db, sessionSecret: env.sessionSecret, now: new Date() });
    const consensus = await consensusView(db, id);
    const side = await viewerSide(db, { teamAId: view.match.teamAId, teamBId: view.match.teamBId }, user?.id ?? null);
    return ok({ ...view, consensus, viewerSide: side });
  });
}
