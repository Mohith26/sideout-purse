import type { Actor } from '../actor';
import type { AppContext } from '../context';
import { describeFailure } from '../../purse';
import { requirePurse } from './deps';
import { pushMatchScores, type PushOutcome } from './scores';

/**
 * What a route does with Purse once its own transaction has committed. Nothing here can
 * fail the request whose work already committed: a Purse failure is recorded on the
 * consensus (and in `purse_calls`) and reported in the response, for the organizer's
 * retry.
 */
export type PurseReport = { status: PushOutcome['purse'] | 'unavailable'; error?: ReturnType<typeof describeFailure> };

export async function pushAfterAgreed(app: AppContext, input: { matchId: string; actor: Actor; requestId: string; now: Date }): Promise<PurseReport> {
  if (app.purse === null) return { status: 'unavailable', error: { type: 'not_configured', code: 'purse_not_configured', message: 'Purse is not configured on this server.', at: input.now.toISOString() } };
  const deps = requirePurse(app);
  try {
    const outcome = await pushMatchScores(deps, input);
    return outcome.error === undefined ? { status: outcome.purse } : { status: outcome.purse, error: outcome.error };
  } catch (error) {
    app.log.error('purse push failed unexpectedly', { matchId: input.matchId, message: error instanceof Error ? error.message : String(error) });
    return { status: 'agreed', error: describeFailure(error, input.now) };
  }
}
