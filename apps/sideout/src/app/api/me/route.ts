import { requireUser } from '../../../server/auth/current-user';
import { appContext } from '../../../server/context';
import { settleDueDevDonations } from '../../../server/donations/dev';
import { handle, ok } from '../../../server/http/respond';
import { meSnapshot } from '../../../server/me';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The signed-in user, their teams, pending partner invites and donations. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env, donationProvider } = appContext();
    const now = new Date();
    const user = await requireUser(request, { db, sessionSecret: env.sessionSecret, now });
    const clock = { now, reservationTtlMs: env.reservationTtlMs };
    if (donationProvider?.name === 'dev') await settleDueDevDonations(db, clock);
    return ok(await meSnapshot(db, user, clock));
  });
}
