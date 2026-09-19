import { REQUEST_ID_HEADER, type ApiDataEnvelope } from '@purse/types';
import { resolveBuildSha } from '@repo/logger';

import { env } from '../../env';
import { logger } from '../../lib/logger';
import { readOrMintRequestId } from '../../lib/request-id';

export const dynamic = 'force-dynamic';

/**
 * The console's `/health` (spec section 10), simpler than the API's: the console owns no
 * database and no ledger, so it reports its commit sha and whether the Purse API it
 * renders from answers its own `/health`. Always 200 when the process is up: the API
 * being down is reported, not inherited, so the hosted health check restarts the console
 * only for the console's own sake. Open to anyone (the middleware exempts it), and it
 * never includes the API origin, a token or a hostname.
 */
export type ConsoleHealthReport = {
  sha: string;
  /** What the API's `/health` answered: `ok`, `failing` (its last reconcile failed), or `unreachable`. */
  api: 'ok' | 'failing' | 'unreachable';
};

export async function GET(request: Request): Promise<Response> {
  const config = env();
  const requestId = readOrMintRequestId(request.headers.get(REQUEST_ID_HEADER));
  const log = logger(config.logLevel).child({ requestId });
  let api: ConsoleHealthReport['api'] = 'unreachable';
  try {
    const response = await fetch(`${config.apiOrigin}/health`, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json', [REQUEST_ID_HEADER]: requestId } });
    if (response.status === 200) api = 'ok';
    else if (response.status === 503) api = 'failing';
  } catch (error) {
    log.warn('health: purse api unreachable', { reason: error instanceof Error ? error.message : String(error) });
  }
  const body: ApiDataEnvelope<ConsoleHealthReport> = { data: { sha: resolveBuildSha(config.buildSha), api } };
  log.info('request', { method: 'GET', path: '/health', status: 200, api });
  return Response.json(body, { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } });
}
