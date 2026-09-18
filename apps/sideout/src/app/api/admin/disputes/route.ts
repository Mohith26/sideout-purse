import { z } from 'zod';

import { requireOrganizer } from '../../../../server/auth/current-user';
import { listDisputes } from '../../../../server/consensus';
import { appContext } from '../../../../server/context';
import { parseQuery } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { toPublicMatch } from '../../../../server/public-shape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({ tournamentId: z.string().startsWith('trn_').optional() });

/** The dispute queue: every match whose two teams disagree, oldest first. Organizers only. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now: new Date() });
    const query = parseQuery(request, querySchema);
    const disputes = await listDisputes(db, query.tournamentId);
    return ok({
      disputes: disputes.map((d) => ({
        match: toPublicMatch(d.match, []),
        tournament: d.tournament,
        poolLabel: d.poolLabel,
        teamA: d.teamA,
        teamB: d.teamB,
        consensus: d.consensus,
      })),
    });
  });
}
