import { eq } from 'drizzle-orm';

import { tournaments } from '../../../../../../db/schema';
import { requireOrganizer } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import { failure } from '../../../../../../server/http/errors';
import type { RouteContext } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { closeBlockers } from '../../../../../../server/purse/close';
import { readBackEntries, reconcileEntries } from '../../../../../../server/purse/contests';
import { requirePurse } from '../../../../../../server/purse/deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The organizer's view of a tournament on Purse: the contest and its state, the entry
 * reconciliation (every player of a confirmed team against Purse's entrants, with who is
 * missing and who is extra), and what would block a close. Reads the entrants back from
 * Purse first when the tournament has a contest.
 */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    await requireOrganizer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const [tournament] = await app.db.select().from(tournaments).where(eq(tournaments.id, id));
    if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
    let readBack: { ok: true } | { ok: false; reason: string } = { ok: false, reason: 'no contest yet' };
    if (tournament.status !== 'draft' && app.purse !== null) {
      try {
        await readBackEntries(requirePurse(app), tournament, { requestId, now });
        readBack = { ok: true };
      } catch (error) {
        readBack = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    const [fresh] = await app.db.select().from(tournaments).where(eq(tournaments.id, id));
    const reconciliation = await reconcileEntries(app.db, fresh ?? tournament);
    return ok({ tournamentId: id, status: (fresh ?? tournament).status, readBack, reconciliation, blockers: await closeBlockers(app.db, id) });
  });
}
