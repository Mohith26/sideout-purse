import { PurseApiError } from '../../../../purse';
import { handle, ok } from '../../../../server/http/respond';
import { purseFailureToApi, requirePurse } from '../../../../server/purse/deps';
import { readPurseProfile } from '../../../../server/purse/users';
import { signedIn } from '../../../../server/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The signed-in player's Purse profile: linked or not, and the wallet as Purse holds it now. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { app, player } = await signedIn(request);
    if (player.purseUserId === null || app.purse === null) return ok({ linked: false, verification: null, wallet: [], configured: app.purse !== null });
    try {
      return ok({ ...(await readPurseProfile(requirePurse(app), { player, requestId })), configured: true });
    } catch (error) {
      // Purse no longer knows the user (its demo reset removes every user nightly): unlinked, so the link is offered again.
      if (error instanceof PurseApiError && error.type === 'invalid_request') return ok({ linked: false, verification: null, wallet: [], configured: true });
      return purseFailureToApi(error);
    }
  });
}
