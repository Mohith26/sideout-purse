import { randomUUID } from 'node:crypto';

import { EMBED_FLOWS } from '@purse/types';
import { z } from 'zod';

import { failure } from '../../../../../server/http/errors';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { ensureMirroredContest, loadSeason } from '../../../../../server/purse/contests';
import { mintEmbedToken } from '../../../../../server/purse/users';
import { signedIn, withPurse } from '../../../../../server/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ flow: z.enum(EMBED_FLOWS), seasonId: z.string().min(1).optional() });

/**
 * A single-use embed token for one of the signed-in player's Purse flows, plus what the
 * SDK needs to mount it. The `entry` flow names a season and gets its contest id back.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    const body = await parseJsonBody(request, bodySchema);
    return withPurse(app, async (deps) => {
      let contestId: string | null = null;
      if (body.flow === 'entry') {
        if (body.seasonId === undefined) throw failure.invalidRequest('season_required', 'The entry flow needs the season to enter.');
        const season = await loadSeason(app.db, body.seasonId);
        if (season.status !== 'enrolling') throw failure.invalidState('entries_closed', `${season.title} is ${season.status}; it no longer takes entries.`);
        contestId = (await ensureMirroredContest(deps, season, { requestId, now })).id;
      }
      const grant = await mintEmbedToken(deps, { player, flow: body.flow, requestId, nonce: randomUUID() });
      return ok({ ...grant, contestId });
    });
  });
}
