import { appContext } from '../../../../../server/context';
import { settleDueDevDonations } from '../../../../../server/donations/dev';
import { failure } from '../../../../../server/http/errors';
import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { tournamentImpact } from '../../../../../server/impact';
import { findPublicTournament } from '../../../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Raised against goal and recent donors, derived from `donations` rows only. */
export async function GET(request: Request, context: RouteContext<{ slug: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, donationProvider } = appContext();
    const { slug } = await context.params;
    const found = await findPublicTournament(db, slug);
    if (found === null) throw failure.notFound('tournament_not_found', 'No such tournament.');
    if (donationProvider?.name === 'dev') await settleDueDevDonations(db, new Date());
    return ok(await tournamentImpact(db, found.tournament));
  });
}
