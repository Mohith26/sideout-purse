import type { RouteContext } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { previewClose } from '../../../../../../server/purse/close';
import { signedIn, withPurse } from '../../../../../../server/route-helpers';
import { seasonView } from '../../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Step 1 of the close: push the final scores, fetch Purse's preview and freeze it on the season. */
export async function POST(request: Request, context: RouteContext<{ seasonId: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    const { seasonId } = await context.params;
    const { season, preview, standings } = await withPurse(app, (deps) => previewClose(deps, { seasonId, actor: player, requestId, now }));
    return ok({ payoutHash: preview.payoutHash, escrowTotal: preview.escrowTotal, payouts: preview.payouts, standings, season: await seasonView(app.db, season, player) });
  });
}
