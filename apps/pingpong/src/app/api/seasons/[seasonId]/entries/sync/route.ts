import type { RouteContext } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { loadSeason, readBackEntries } from '../../../../../../server/purse/contests';
import { signedIn, withPurse } from '../../../../../../server/route-helpers';
import { seasonView } from '../../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Read the contest's entrants back from Purse and seat the new ones at the bottom of the ladder. Called after the entry flow completes. */
export async function POST(request: Request, context: RouteContext<{ seasonId: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    const { seasonId } = await context.params;
    const season = await loadSeason(app.db, seasonId);
    const { added } = await withPurse(app, (deps) => readBackEntries(deps, season, { requestId, now }));
    return ok({ added, season: await seasonView(app.db, await loadSeason(app.db, seasonId), player) });
  });
}
