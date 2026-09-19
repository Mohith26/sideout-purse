import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { declineChallenge } from '../../../../../server/matches';
import { loadSeason } from '../../../../../server/purse/contests';
import { signedIn } from '../../../../../server/route-helpers';
import { seasonView } from '../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The challenged player declines. */
export async function POST(request: Request, context: RouteContext<{ matchId: string }>): Promise<Response> {
  return handle(request, async () => {
    const { app, player, now } = await signedIn(request);
    const { matchId } = await context.params;
    const match = await declineChallenge(app.db, { matchId, actor: player, now });
    return ok({ matchId: match.id, status: match.status, season: await seasonView(app.db, await loadSeason(app.db, match.seasonId), player) });
  });
}
