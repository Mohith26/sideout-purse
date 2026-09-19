import { appContext } from '../../../../server/context';
import { currentPlayer } from '../../../../server/auth/current-player';
import { handle, ok } from '../../../../server/http/respond';
import { currentSeason, seasonView } from '../../../../server/seasons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The season on the board, as the signed-in player (or a visitor) sees it; `{ season: null }` before the first. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const app = appContext();
    const viewer = await currentPlayer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now: new Date() });
    const season = await currentSeason(app.db);
    return ok({ season: season === null ? null : await seasonView(app.db, season, viewer) });
  });
}
