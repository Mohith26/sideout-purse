import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { requirePurse } from '../../../../../server/purse/deps';
import { pushMatchScores } from '../../../../../server/purse/scores';
import { signedIn } from '../../../../../server/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Retry a confirmed result's push to Purse under the key minted at confirmation. */
export async function POST(request: Request, context: RouteContext<{ matchId: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, now } = await signedIn(request);
    const { matchId } = await context.params;
    return ok({ matchId, push: await pushMatchScores(requirePurse(app), { matchId, requestId, now }) });
  });
}
