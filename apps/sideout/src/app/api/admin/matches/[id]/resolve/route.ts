import { resolutionScorelineSchema } from '../../../../../../domain/consensus';
import { actorFor } from '../../../../../../server/actor';
import { requireOrganizer } from '../../../../../../server/auth/current-user';
import { consensusView, resolveDispute } from '../../../../../../server/consensus';
import { appContext } from '../../../../../../server/context';
import type { RouteContext } from '../../../../../../server/http/input';
import { parseJsonBody } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { toPublicMatch } from '../../../../../../server/public-shape';
import { pushAfterAgreed } from '../../../../../../server/purse/after-commit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** An organizer settles a dispute with the authoritative scoreline (team A's points first), attributed to them; the result is pushed to Purse. */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, resolutionScorelineSchema);
    const result = await resolveDispute(app.db, { matchId: id, organizer, sets: body.sets, now });
    const purse = await pushAfterAgreed(app, { matchId: id, actor: actorFor(organizer), requestId, now });
    return ok({ match: toPublicMatch(result.match, []), submissionId: result.submissionId, consensus: await consensusView(app.db, id), purse });
  });
}
