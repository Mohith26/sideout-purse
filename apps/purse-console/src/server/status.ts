import { REQUEST_ID_HEADER, type PublicStatusResource } from '@purse/types';
import { resolveBuildSha } from '@repo/logger';

import { env, type Env } from '../env';
import { logger } from '../lib/logger';

/**
 * What the public `/status` page renders (spec section 12, stretch item 5), gathered on
 * the server: the Purse API's public status feed (`GET /v1/status`, the stored reconcile
 * record; the API never runs `reconcile()` for it) and one probe of each service's
 * `/health`. The visitor's browser fetches nothing: every origin is read from here, with a
 * short timeout, and the answers are kept in process memory for `TTL_MS` so a page view is
 * never more than one round of requests per half minute, whatever the traffic. When a
 * probe fails, the last good answer is shown as stale for up to `STALE_MS` before the
 * service is reported down: a blip is not an outage, a minute of silence is.
 */
export type ServiceId = 'purse' | 'console' | 'sideout';

export type ServiceCheck = {
  id: ServiceId;
  label: string;
  state: 'up' | 'down' | 'not_configured';
  /** A short plain sentence for the row: what the probe found. */
  note: string;
  /** When the state was last confirmed by a probe, or when the failing probe ran. */
  checkedAt: string;
  /** True when the state comes from an earlier probe because the latest one failed. */
  stale: boolean;
};

export type StatusPageData = {
  /** The API's feed, or `null` while it cannot be read at all. */
  feed: PublicStatusResource | null;
  feedCheckedAt: string;
  feedStale: boolean;
  services: ServiceCheck[];
  consoleSha: string;
  generatedAt: string;
};

export const TTL_MS = 30_000;
export const STALE_MS = 120_000;
export const PROBE_TIMEOUT_MS = 3000;

export type ProbeResult<T> = { ok: true; value: T; checkedAt: number; stale: boolean } | { ok: false; reason: string; checkedAt: number };

/**
 * One value, loaded at most once per `ttlMs` and served from memory in between. A failed
 * load keeps the last good value for `staleMs` past its own check (marked stale), and is
 * itself remembered for `ttlMs` so a dead origin is not probed on every page view.
 */
export class ProbeCache<T> {
  private value: { value: T; checkedAt: number } | undefined;
  private attempt: { at: number; result: ProbeResult<T> } | undefined;
  private inFlight: Promise<ProbeResult<T>> | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly staleMs: number,
  ) {}

  async read(now: number, load: () => Promise<T>): Promise<ProbeResult<T>> {
    if (this.attempt !== undefined && now - this.attempt.at < this.ttlMs) return this.attempt.result;
    this.inFlight ??= this.probe(now, load).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  reset(): void {
    this.value = undefined;
    this.attempt = undefined;
  }

  private async probe(now: number, load: () => Promise<T>): Promise<ProbeResult<T>> {
    let result: ProbeResult<T>;
    try {
      const value = await load();
      this.value = { value, checkedAt: now };
      result = { ok: true, value, checkedAt: now, stale: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const lastGood = this.value !== undefined && now - this.value.checkedAt < this.staleMs ? this.value : null;
      if (lastGood === null) this.value = undefined;
      result = lastGood === null ? { ok: false, reason, checkedAt: now } : { ok: true, value: lastGood.value, checkedAt: lastGood.checkedAt, stale: true };
    }
    this.attempt = { at: now, result };
    return result;
  }
}

export type SideoutHealth = { up: boolean; status: number };

export type StatusDeps = {
  env: Env;
  fetch: typeof fetch;
  clock: () => number;
  requestId?: string | undefined;
  feed: ProbeCache<PublicStatusResource>;
  sideout: ProbeCache<SideoutHealth>;
};

const feedCache = new ProbeCache<PublicStatusResource>(TTL_MS, STALE_MS);
const sideoutCache = new ProbeCache<SideoutHealth>(TTL_MS, STALE_MS);

/** The page's data with the process's caches and configuration. */
export function loadStatusPage(requestId?: string): Promise<StatusPageData> {
  return gatherStatus({ env: env(), fetch, clock: Date.now, requestId, feed: feedCache, sideout: sideoutCache });
}

export async function gatherStatus(deps: StatusDeps): Promise<StatusPageData> {
  const now = deps.clock();
  const log = logger(deps.env.logLevel).child({ requestId: deps.requestId ?? null, component: 'status' });
  const [feed, sideout] = await Promise.all([
    deps.feed.read(now, () => readFeed(deps)),
    deps.env.sideoutOrigin === undefined ? Promise.resolve(undefined) : deps.sideout.read(now, () => probeSideout(deps)),
  ]);
  if (!feed.ok) log.warn('status: purse feed unreadable', { reason: feed.reason });
  if (sideout !== undefined && !sideout.ok) log.warn('status: sideout unreachable', { reason: sideout.reason });

  const services: ServiceCheck[] = [
    feed.ok
      ? { id: 'purse', label: 'Purse API', state: 'up', note: feed.stale ? 'Answered earlier; the latest check did not complete' : 'Answering', checkedAt: iso(feed.checkedAt), stale: feed.stale }
      : { id: 'purse', label: 'Purse API', state: 'down', note: 'Not answering', checkedAt: iso(feed.checkedAt), stale: false },
    { id: 'console', label: 'Operator console', state: 'up', note: 'Rendered this page', checkedAt: iso(now), stale: false },
    sideoutService(sideout, now),
  ];
  return {
    feed: feed.ok ? feed.value : null,
    feedCheckedAt: iso(feed.checkedAt),
    feedStale: feed.ok && feed.stale,
    services,
    consoleSha: resolveBuildSha(deps.env.buildSha),
    generatedAt: iso(now),
  };
}

function sideoutService(probe: ProbeResult<SideoutHealth> | undefined, now: number): ServiceCheck {
  const base = { id: 'sideout' as const, label: 'Sideout' };
  if (probe === undefined) return { ...base, state: 'not_configured', note: 'Not configured on this console', checkedAt: iso(now), stale: false };
  if (!probe.ok) return { ...base, state: 'down', note: 'Not answering', checkedAt: iso(probe.checkedAt), stale: false };
  const note = probe.value.up ? (probe.stale ? 'Answered earlier; the latest check did not complete' : 'Answering') : 'Answering, but reporting its own database unreachable';
  return { ...base, state: probe.value.up ? 'up' : 'down', note, checkedAt: iso(probe.checkedAt), stale: probe.stale };
}

async function readFeed(deps: StatusDeps): Promise<PublicStatusResource> {
  const response = await deps.fetch(`${deps.env.apiOrigin}/v1/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: headersFor(deps), cache: 'no-store' });
  if (response.status !== 200) throw new Error(`purse answered ${response.status}`);
  const body = (await response.json()) as { data?: PublicStatusResource };
  if (body.data === undefined || !Array.isArray(body.data.invariants) || !Array.isArray(body.data.runs)) throw new Error('purse answered without a status envelope');
  return body.data;
}

/** Sideout's `/health` answers 200 when it is up and 503 only when its own database is unreachable; anything else is not Sideout. */
async function probeSideout(deps: StatusDeps): Promise<SideoutHealth> {
  const response = await deps.fetch(`${deps.env.sideoutOrigin}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: headersFor(deps), cache: 'no-store' });
  if (response.status !== 200 && response.status !== 503) throw new Error(`sideout answered ${response.status}`);
  return { up: response.status === 200, status: response.status };
}

function headersFor(deps: StatusDeps): Record<string, string> {
  return deps.requestId === undefined ? { accept: 'application/json' } : { accept: 'application/json', [REQUEST_ID_HEADER]: deps.requestId };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
