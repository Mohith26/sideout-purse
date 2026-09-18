import { requireUser } from '../../../../server/auth/current-user';
import { appContext } from '../../../../server/context';
import { handle, ok } from '../../../../server/http/respond';
import { purseFailureToApi } from '../../../../server/purse/contests';
import { requirePurse } from '../../../../server/purse/deps';
import { readPurseProfile } from '../../../../server/purse/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The signed-in user's Purse profile read back live: verification state, restrictions and wallet. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    if (user.purseUserId === null) return ok({ linked: false, verification: null, restrictions: [], wallet: [], displayName: null });
    try {
      return ok(await readPurseProfile(requirePurse(app), { user, requestId, now }));
    } catch (error) {
      return purseFailureToApi(error);
    }
  });
}
