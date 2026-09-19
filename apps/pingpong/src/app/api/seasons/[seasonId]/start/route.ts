import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { signedIn, withPurse } from '../../../../../server/route-helpers';
import { seasonView, startSeason } from '../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The commissioner starts play: the Purse contest is locked and started, and challenges open. */
export async function POST(request: Request, context: RouteContext<{ seasonId: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    const { seasonId } = await context.params;
    const season = await withPurse(app, (deps) => startSeason(deps, { seasonId, actor: player, requestId, now }));
    return ok({ season: await seasonView(app.db, season, player) });
  });
}
