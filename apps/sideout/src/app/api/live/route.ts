import { clientAddress } from '../../../server/auth/client-address';
import { appContext } from '../../../server/context';
import { handle } from '../../../server/http/respond';
import { liveBus } from '../../../server/live/bus';
import { openLiveStream } from '../../../server/live/stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The live feed of every tournament (docs/live.md): what the home strip and the dispute
 * queue subscribe to, since a strip appears when any event goes live. Public, and carries
 * only ids and kinds. `Last-Event-ID` (or `?lastEventId=`, for a client that reconnects by
 * hand) resumes from the bus's ring.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async ({ log }) => {
    const app = appContext();
    const url = new URL(request.url);
    return openLiveStream(
      { bus: liveBus(), log, config: app.env.live },
      { channel: { kind: 'all' }, lastEventId: request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId'), address: clientAddress(request.headers, app.env.trustedProxyHops), signal: request.signal },
    );
  });
}
