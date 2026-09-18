import { actorFor } from '../../../../../../../server/actor';
import { requireOrganizer } from '../../../../../../../server/auth/current-user';
import { consensusView } from '../../../../../../../server/consensus';
import { appContext } from '../../../../../../../server/context';
import type { RouteContext } from '../../../../../../../server/http/input';
import { handle, ok } from '../../../../../../../server/http/respond';
import { requirePurse } from '../../../../../../../server/purse/deps';
import { pushMatchScores } from '../../../../../../../server/purse/scores';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Retry the Purse push (from `agreed`) or its confirmation (from `pushed_to_purse`), under the key minted at `agreed`. Organizers only. */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const outcome = await pushMatchScores(requirePurse(app), { matchId: id, actor: actorFor(organizer), requestId, now, retry: true });
    return ok({ purse: outcome.error === undefined ? { status: outcome.purse } : { status: outcome.purse, error: outcome.error }, consensus: await consensusView(app.db, id) });
  });
}
