import { z } from 'zod';

import { parseJsonBody } from '../../../server/http/input';
import { handle, ok } from '../../../server/http/respond';
import { ensureMirroredContest } from '../../../server/purse/contests';
import { requirePurse } from '../../../server/purse/deps';
import { isPurseFailure } from '../../../purse';
import { signedIn } from '../../../server/route-helpers';
import { openSeason, seasonView } from '../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ title: z.string().min(1).max(80) });

/** Open the next season; the opener is its commissioner. The Purse contest is created and opened after the commit, never fatally. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId, log }) => {
    const { app, player, now } = await signedIn(request);
    const body = await parseJsonBody(request, bodySchema);
    let season = await openSeason(app.db, { title: body.title, commissioner: player, now });
    if (app.purse !== null) {
      try {
        const contest = await ensureMirroredContest(requirePurse(app), season, { requestId, now });
        season = { ...season, purseContestId: contest.id, purseContestState: contest.state };
      } catch (error) {
        if (!isPurseFailure(error)) throw error;
        // The next Purse-facing step (an entry token, the start) runs the same idempotent mirror again.
        log.warn('purse contest not created with the season', { seasonId: season.id, reason: error.message });
      }
    }
    return ok({ season: await seasonView(app.db, season, player) }, { status: 201 });
  });
}
