import { appContext } from '../../../../server/context';
import { failure } from '../../../../server/http/errors';
import type { RouteContext } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { tournamentDetail } from '../../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A tournament with its teams, pools (with standings), bracket and sponsors. Drafts are 404. */
export async function GET(request: Request, context: RouteContext<{ slug: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db } = appContext();
    const { slug } = await context.params;
    const detail = await tournamentDetail(db, slug);
    if (detail === null) throw failure.notFound('tournament_not_found', 'No such tournament.');
    return ok(detail);
  });
}
