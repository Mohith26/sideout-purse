import { z } from 'zod';

import { parseJsonBody, type RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { challenge } from '../../../../../server/matches';
import { loadSeason } from '../../../../../server/purse/contests';
import { signedIn } from '../../../../../server/route-helpers';
import { seasonView } from '../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ defenderId: z.string().min(1) });

/** Challenge a player above you (within reach, neither of you busy). */
export async function POST(request: Request, context: RouteContext<{ seasonId: string }>): Promise<Response> {
  return handle(request, async () => {
    const { app, player, now } = await signedIn(request);
    const { seasonId } = await context.params;
    const body = await parseJsonBody(request, bodySchema);
    const match = await challenge(app.db, { seasonId, challenger: player, defenderId: body.defenderId, now });
    return ok({ matchId: match.id, season: await seasonView(app.db, await loadSeason(app.db, seasonId), player) }, { status: 201 });
  });
}
