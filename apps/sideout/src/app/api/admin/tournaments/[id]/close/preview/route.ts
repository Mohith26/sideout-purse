import { requireOrganizer } from '../../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../../server/context';
import type { RouteContext } from '../../../../../../../server/http/input';
import { handle, ok } from '../../../../../../../server/http/respond';
import { previewClose } from '../../../../../../../server/purse/close';
import { purseFailureToApi } from '../../../../../../../server/purse/contests';
import { requirePurse } from '../../../../../../../server/purse/deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Step 1 of the close: Purse's frozen settlement preview with its payout hash, or the named blockers. Organizers only. */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    try {
      return ok(await previewClose(requirePurse(app), { tournamentId: id, organizer, requestId, now }));
    } catch (error) {
      return purseFailureToApi(error);
    }
  });
}
