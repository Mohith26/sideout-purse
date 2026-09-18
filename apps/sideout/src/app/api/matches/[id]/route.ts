import { appContext } from '../../../../server/context';
import { failure } from '../../../../server/http/errors';
import type { RouteContext } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { matchView } from '../../../../server/matches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One match with its sets and teams. Matches of draft tournaments are 404. */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db } = appContext();
    const { id } = await context.params;
    const view = await matchView(db, id);
    if (view === null) throw failure.notFound('match_not_found', 'No such match.');
    return ok(view);
  });
}
