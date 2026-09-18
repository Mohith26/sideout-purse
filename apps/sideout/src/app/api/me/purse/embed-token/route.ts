import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { EMBED_FLOWS } from '@purse/types';
import { z } from 'zod';

import { tournaments } from '../../../../../db/schema';
import { requireUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import { failure } from '../../../../../server/http/errors';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { ensurePurseContest, purseFailureToApi } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';
import { mintEmbedToken } from '../../../../../server/purse/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ flow: z.enum(EMBED_FLOWS), tournamentSlug: z.string().min(1).optional() });

/**
 * A single-use embed token for one of the signed-in player's Purse flows, plus what the
 * SDK needs to mount it. The `entry` flow names a tournament and gets its contest id back.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const body = await parseJsonBody(request, bodySchema);
    const deps = requirePurse(app);
    let contestId: string | null = null;
    if (body.flow === 'entry') {
      if (body.tournamentSlug === undefined) throw failure.invalidRequest('tournament_required', 'The entry flow needs the tournament to enter.');
      const [tournament] = await app.db.select().from(tournaments).where(eq(tournaments.slug, body.tournamentSlug));
      if (tournament === undefined || tournament.status === 'draft') throw failure.notFound('tournament_not_found', 'No such tournament.');
      if (tournament.status !== 'registration_open' && tournament.status !== 'registration_closed') {
        throw failure.invalidState('entries_closed', `${tournament.name} is ${tournament.status.replace('_', ' ')}; the contest no longer takes entries.`);
      }
      try {
        contestId = (await ensurePurseContest(deps, tournament, { requestId, now })).id;
      } catch (error) {
        return purseFailureToApi(error);
      }
    }
    try {
      const grant = await mintEmbedToken(deps, { user, flow: body.flow, requestId, nonce: randomUUID() });
      return ok({ ...grant, contestId });
    } catch (error) {
      return purseFailureToApi(error);
    }
  });
}
