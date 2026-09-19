import { z } from 'zod';

import { parseJsonBody, type RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { closeSeason } from '../../../../../server/purse/close';
import { signedIn, withPurse } from '../../../../../server/route-helpers';
import { seasonView } from '../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ payoutHash: z.string().regex(/^[0-9a-f]{64}$/) });

/** Step 2 of the close: confirm the frozen preview's hash; Purse settles and the season closes. */
export async function POST(request: Request, context: RouteContext<{ seasonId: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    const { seasonId } = await context.params;
    const body = await parseJsonBody(request, bodySchema);
    const { season, settlement, replayed } = await withPurse(app, (deps) => closeSeason(deps, { seasonId, payoutHash: body.payoutHash, actor: player, requestId, now }));
    return ok({ replayed, payoutHash: settlement.payoutHash, results: settlement.results.map((r) => ({ userId: r.userId, placement: r.placement, payoutAmount: r.payoutAmount })), season: await seasonView(app.db, season, player) });
  });
}
