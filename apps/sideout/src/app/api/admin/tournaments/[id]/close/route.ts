import { z } from 'zod';

import { requireOrganizer } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import type { RouteContext } from '../../../../../../server/http/input';
import { parseJsonBody } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';
import { closeStatus, closeTournament } from '../../../../../../server/purse/close';
import { purseFailureToApi } from '../../../../../../server/purse/contests';
import { requirePurse } from '../../../../../../server/purse/deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const closeSchema = z.strictObject({ payoutHash: z.string().regex(/^[0-9a-f]{64}$/, 'the 64-character hex digest from the preview') });

/** The close page's state: blockers, and the frozen preview if one is held. Organizers only. */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now: new Date() });
    const { id } = await context.params;
    const status = await closeStatus(db, id);
    return ok({ tournamentId: status.tournament.id, status: status.tournament.status, blockers: status.blockers, frozen: status.frozen, standings: status.standings });
  });
}

/** Step 2 of the close: confirm the frozen preview's hash; Purse settles and the tournament is settled. Organizers only. */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, closeSchema);
    let closed;
    try {
      closed = await closeTournament(requirePurse(app), { tournamentId: id, payoutHash: body.payoutHash, organizer, requestId, now, reservationTtlMs: app.env.reservationTtlMs });
    } catch (error) {
      return purseFailureToApi(error);
    }
    return ok({
      tournamentId: closed.tournament.id,
      status: closed.tournament.status,
      replayed: closed.replayed,
      settlement: {
        contestId: closed.settlement.contest.id,
        contestState: closed.settlement.contest.state,
        payoutHash: closed.settlement.payoutHash,
        journalEntryId: closed.settlement.journalEntryId,
        results: closed.settlement.results.map((r) => ({ userId: r.userId, placement: r.placement, score: r.score, payoutAmount: r.payoutAmount })),
      },
    });
  });
}
