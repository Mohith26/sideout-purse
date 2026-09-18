import { appContext } from '../../../../../server/context';
import { failure } from '../../../../../server/http/errors';
import type { RouteContext } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { tournamentStandings } from '../../../../../server/standings';
import { findPublicTournament } from '../../../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Pool standings computed from `sets` on every request; cacheable for ten seconds (D11 polling). */
export async function GET(request: Request, context: RouteContext<{ slug: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db } = appContext();
    const { slug } = await context.params;
    const found = await findPublicTournament(db, slug);
    if (found === null) throw failure.notFound('tournament_not_found', 'No such tournament.');
    const pools = await tournamentStandings(db, found.tournament.id);
    return ok(
      { tournamentId: found.tournament.id, slug, status: found.tournament.status, pools },
      { headers: { 'cache-control': 'public, max-age=10, stale-while-revalidate=10' } },
    );
  });
}
