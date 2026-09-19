import { z } from 'zod';

import { parseJsonBody, type RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { reportResult } from '../../../../../server/matches';
import { loadSeason } from '../../../../../server/purse/contests';
import { signedIn } from '../../../../../server/route-helpers';
import { seasonView } from '../../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ challengerScore: z.number().int().min(0).max(99), defenderScore: z.number().int().min(0).max(99) });

/** Either player enters the scoreline; the other confirms it. */
export async function POST(request: Request, context: RouteContext<{ matchId: string }>): Promise<Response> {
  return handle(request, async () => {
    const { app, player, now } = await signedIn(request);
    const { matchId } = await context.params;
    const body = await parseJsonBody(request, bodySchema);
    const match = await reportResult(app.db, { matchId, actor: player, challengerScore: body.challengerScore, defenderScore: body.defenderScore, now });
    return ok({ matchId: match.id, status: match.status, season: await seasonView(app.db, await loadSeason(app.db, match.seasonId), player) });
  });
}
