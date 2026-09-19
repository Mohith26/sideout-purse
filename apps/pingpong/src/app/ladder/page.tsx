import { redirect } from 'next/navigation';

import { LadderScreen, type Profile } from '../../components/LadderScreen';
import { pagePlayer } from '../../server/auth/current-player';
import { appContext } from '../../server/context';
import { isPurseFailure, PurseApiError } from '../../purse';
import { requirePurse } from '../../server/purse/deps';
import { readPurseProfile } from '../../server/purse/users';
import { currentSeason, seasonView } from '../../server/seasons';

export const dynamic = 'force-dynamic';

/** The ladder: the season on the board, as the signed-in player sees it, with their Purse profile read live. */
export default async function LadderPage() {
  const app = appContext();
  const now = new Date();
  const player = await pagePlayer({ db: app.db, sessionSecret: app.env.sessionSecret, now });
  if (player === null) redirect('/');
  const season = await currentSeason(app.db);
  const view = season === null ? null : await seasonView(app.db, season, player);
  let profile: Profile = { linked: false, configured: app.purse !== null, wallet: [] };
  if (app.purse !== null && player.purseUserId !== null) {
    try {
      const read = await readPurseProfile(requirePurse(app), { player, requestId: crypto.randomUUID() });
      profile = { linked: read.linked, configured: true, wallet: read.wallet.map((b) => ({ asset: b.asset, balance: b.balance })) };
    } catch (error) {
      if (!isPurseFailure(error)) throw error;
      // Purse no longer knows the user (its demo reset removes every user nightly, docs/second-tenant.md): offer the link again. Anything else: linked, wallet unknown.
      profile = error instanceof PurseApiError && error.type === 'invalid_request' ? { linked: false, configured: true, wallet: [] } : { linked: true, configured: true, wallet: [] };
    }
  }
  return <LadderScreen me={{ id: player.id, name: player.name }} season={view} profile={profile} />;
}
