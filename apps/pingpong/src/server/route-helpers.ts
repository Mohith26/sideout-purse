import { appContext, type AppContext } from './context';
import { requirePlayer } from './auth/current-player';
import type { Player } from '../db/schema';
import { purseFailureToApi, requirePurse, type PurseDeps } from './purse/deps';

/**
 * What every route handler does first: the app context, the clock, and (for most) the
 * signed-in player. `withPurse` runs a Purse-facing step and maps a Purse failure to the
 * API's answer for it.
 */
export async function signedIn(request: Request): Promise<{ app: AppContext; player: Player; now: Date }> {
  const app = appContext();
  const now = new Date();
  const player = await requirePlayer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
  return { app, player, now };
}

export async function withPurse<T>(app: AppContext, run: (deps: PurseDeps) => Promise<T>): Promise<T> {
  const deps = requirePurse(app);
  try {
    return await run(deps);
  } catch (error) {
    return purseFailureToApi(error);
  }
}
