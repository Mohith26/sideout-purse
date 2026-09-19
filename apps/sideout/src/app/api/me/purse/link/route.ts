import { requireUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import { mirrorPendingDevices } from '../../../../../server/devices';
import { handle, ok } from '../../../../../server/http/respond';
import { purseFailureToApi } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';
import { linkPurseUser } from '../../../../../server/purse/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Create or refresh the signed-in user's Purse account (upsert by the opaque external id)
 * and record the link. A phone checked in before the link had nothing to mirror to; its
 * key is mirrored now (never fatal to the link; audited if it fails).
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    let profile;
    try {
      profile = await linkPurseUser(requirePurse(app), { user, requestId, now });
    } catch (error) {
      return purseFailureToApi(error);
    }
    try {
      await mirrorPendingDevices(requirePurse(app), user.id, { requestId, now });
    } catch (error) {
      app.log.error('device mirror after link failed', { userId: user.id, message: error instanceof Error ? error.message : String(error) });
    }
    return ok(profile);
  });
}
