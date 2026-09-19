import { handle, ok } from '../../../../../server/http/respond';
import { linkPurseUser } from '../../../../../server/purse/users';
import { signedIn, withPurse } from '../../../../../server/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Link (upsert) the player's Purse account and read the profile back. Safe to repeat. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player, now } = await signedIn(request);
    return ok(await withPurse(app, (deps) => linkPurseUser(deps, { player, requestId, now })));
  });
}
