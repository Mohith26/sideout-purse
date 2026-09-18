import { appContext } from '../../../server/context';
import { parseQuery } from '../../../server/http/input';
import { handle, ok } from '../../../server/http/respond';
import { listPublicTournaments, listTournamentsQuerySchema } from '../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Every non-draft tournament, optionally filtered by `?status=`. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db } = appContext();
    const query = parseQuery(request, listTournamentsQuerySchema);
    return ok({ tournaments: await listPublicTournaments(db, { status: query.status }) });
  });
}
