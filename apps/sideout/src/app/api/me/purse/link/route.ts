import { requireUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import { handle, ok } from '../../../../../server/http/respond';
import { purseFailureToApi } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';
import { linkPurseUser } from '../../../../../server/purse/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Create or refresh the signed-in user's Purse account (upsert by the opaque external id) and record the link. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    try {
      return ok(await linkPurseUser(requirePurse(app), { user, requestId, now }));
    } catch (error) {
      return purseFailureToApi(error);
    }
  });
}
