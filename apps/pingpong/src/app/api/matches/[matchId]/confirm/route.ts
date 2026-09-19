import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { confirmResult } from '../../../../../server/matches';
import { loadSeason } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';
import { pushMatchScores, type PushOutcome } from '../../../../../server/purse/scores';
import { signedIn } from '../../../../../server/route-helpers';
import { seasonView } from '../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The other player confirms: the ladder moves in the transaction; the scores go to Purse after the commit, never fatally. */
export async function POST(request: Request, context: RouteContext<{ matchId: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    const { matchId } = await context.params;
    const confirmed = await confirmResult(app.db, { matchId, actor: player, now });
    const push: PushOutcome = app.purse === null ? { status: 'skipped', reason: 'Purse is not configured' } : await pushMatchScores(requirePurse(app), { matchId, requestId, now });
    return ok({ matchId, moved: confirmed.moved, push, season: await seasonView(app.db, await loadSeason(app.db, confirmed.match.seasonId), player) });
  });
}
