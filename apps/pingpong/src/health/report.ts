import { SDK_VERSION } from '@purse/sdk';
import { migrationState, type MigrationState, type Sql } from '@repo/db';

/**
 * `GET /health` payload, mirroring Purse's envelope (spec section 10): commit sha,
 * migration state, the Purse SDK version this build was compiled against, and what
 * Purse's own `/health` says right now (its active ruleset version and its last reconcile
 * result), read through one short request so a single probe of the ladder tells an operator
 * whether the platform behind it is well. Purse being unreachable, or answering that its
 * last reconcile failed, is reported in `purse` and never turns the ladder's own answer into
 * an error: this endpoint is the ladder's health, and the hosted deploy's health check and
 * uptime probe read it as such.
 */
export type PurseHealthSummary =
  | { reachable: true; status: 'ok' | 'failing'; rulesetVersion: string | null; reconcile: { ok: boolean; ranAt: string; failed: string[] } | null }
  | { reachable: false; reason: 'unreachable' | 'unexpected_answer' | 'not_configured' };

export type HealthReport = {
  sha: string;
  migrations: MigrationState;
  purseSdkVersion: string;
  purse: PurseHealthSummary;
};

export type PurseHealthProbe = {
  /** The Purse API origin, or `undefined` when none is configured. */
  apiUrl: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 3000;

export async function healthReport(sql: Sql, migrationsFolder: string, sha: string, purse: PurseHealthProbe): Promise<HealthReport> {
  const [migrations, purseSummary] = await Promise.all([migrationState(sql, migrationsFolder), probePurse(purse)]);
  return { sha, migrations, purseSdkVersion: SDK_VERSION, purse: purseSummary };
}

type PurseHealthBody = {
  data?: { status?: unknown; rulesetVersion?: unknown; reconcile?: { ok?: unknown; ranAt?: unknown; failed?: unknown } | null };
};

/** One request to Purse's `/health`; never throws. */
export async function probePurse(probe: PurseHealthProbe): Promise<PurseHealthSummary> {
  if (probe.apiUrl === undefined) return { reachable: false, reason: 'not_configured' };
  const doFetch = probe.fetch ?? fetch;
  let body: PurseHealthBody;
  try {
    const response = await doFetch(`${probe.apiUrl}/health`, { signal: AbortSignal.timeout(probe.timeoutMs ?? DEFAULT_TIMEOUT_MS), headers: { accept: 'application/json' } });
    // 503 with a report is Purse saying its last reconcile failed: still an answer.
    if (response.status !== 200 && response.status !== 503) return { reachable: false, reason: 'unexpected_answer' };
    body = (await response.json()) as PurseHealthBody;
  } catch {
    return { reachable: false, reason: 'unreachable' };
  }
  const data = body.data;
  if (data === undefined || (data.status !== 'ok' && data.status !== 'failing')) return { reachable: false, reason: 'unexpected_answer' };
  const reconcile = data.reconcile ?? null;
  return {
    reachable: true,
    status: data.status,
    rulesetVersion: typeof data.rulesetVersion === 'string' ? data.rulesetVersion : null,
    reconcile:
      reconcile === null || typeof reconcile.ok !== 'boolean' || typeof reconcile.ranAt !== 'string'
        ? null
        : { ok: reconcile.ok, ranAt: reconcile.ranAt, failed: Array.isArray(reconcile.failed) ? reconcile.failed.filter((each): each is string => typeof each === 'string') : [] },
  };
}
