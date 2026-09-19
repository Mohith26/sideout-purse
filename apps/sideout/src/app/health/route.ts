import { REQUEST_ID_HEADER, type ApiDataEnvelope, type ApiErrorEnvelope } from '@purse/types';

import { buildSha } from '../../build-info';
import { database } from '../../db/client';
import { env } from '../../env';
import { healthReport, type HealthReport } from '../../health/report';
import { logger } from '../../lib/logger';
import { readOrMintRequestId } from '../../lib/request-id';
import { migrationsFolder } from '../../paths';

export const dynamic = 'force-dynamic';

/**
 * Sideout's `/health`, in the same `{ data }` / `{ error }` envelope Purse uses so one
 * uptime check understands both services. Never includes a connection string or key.
 * `purse` relays what Purse's `/health` says (ruleset version, last reconcile result) or
 * why it could not be asked; only Sideout's own database being unreachable is a 503.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = readOrMintRequestId(request.headers.get(REQUEST_ID_HEADER));
  const log = logger(env().logLevel).child({ requestId });
  const headers = { [REQUEST_ID_HEADER]: requestId };

  try {
    const config = env();
    // Purse is probed only when Sideout is configured to reach it (a secret key); otherwise the report says so.
    const report = await healthReport(database().sql, migrationsFolder(), buildSha(config.buildSha), { apiUrl: config.purse.secretKey === undefined ? undefined : config.purse.apiUrl });
    const body: ApiDataEnvelope<HealthReport> = { data: report };
    log.info('request', { method: 'GET', path: '/health', status: 200 });
    return Response.json(body, { status: 200, headers });
  } catch (error) {
    log.error('health: database unreachable', { reason: error instanceof Error ? error.message : String(error) });
    const body: ApiErrorEnvelope = {
      error: { type: 'internal_error', code: 'database_unavailable', message: 'Database is unreachable' },
    };
    return Response.json(body, { status: 503, headers });
  }
}
