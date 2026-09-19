import { eq } from 'drizzle-orm';

import { tournaments } from '../../../../../db/schema';
import { clientAddress } from '../../../../../server/auth/client-address';
import { appContext } from '../../../../../server/context';
import { failure } from '../../../../../server/http/errors';
import type { RouteContext } from '../../../../../server/http/input';
import { handle } from '../../../../../server/http/respond';
import { liveBus } from '../../../../../server/live/bus';
import { openLiveStream } from '../../../../../server/live/stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One tournament's live stream (docs/live.md): every screen of a live event subscribes
 * here and re-renders on each event. Public tournament data only, so a draft is as absent
 * here as it is everywhere else; nothing a session gates is ever on the wire.
 */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ log }) => {
    const app = appContext();
    const { id } = await context.params;
    const [row] = await app.db.select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, id));
    if (row === undefined || row.status === 'draft') throw failure.notFound('tournament_not_found', 'No such tournament.');
    const url = new URL(request.url);
    return openLiveStream(
      { bus: liveBus(), log, config: app.env.live },
      { channel: { kind: 'tournament', tournamentId: id }, lastEventId: request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId'), address: clientAddress(request.headers, app.env.trustedProxyHops), signal: request.signal },
    );
  });
}
