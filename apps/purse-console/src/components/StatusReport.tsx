import { Chip, type ChipTone } from '@sideout/ui';
import type { ReconcileRunResource, StatusInvariantState } from '@purse/types';

import { formatInstant } from '../lib/format';
import type { ServiceCheck, StatusPageData } from '../server/status';

/**
 * The public status page's body (spec section 12, stretch item 5): the invariant panel
 * read-only, from the stored record. Plain server-rendered markup, no script: it renders
 * whole on the first byte and refreshes itself with a `meta refresh` every
 * `refreshSeconds`, so a browser with JavaScript off reads the same page. What it shows is
 * whether the platform is healthy and nothing about who uses it: every invariant with its
 * last outcome and the time, the recent runs, the build, and whether each service answers.
 * A failing invariant is named; its detail stays on the operator's panel.
 */
export const STATUS_REFRESH_SECONDS = 60;

const SOURCE_LABEL: Record<ReconcileRunResource['source'], string> = {
  schedule: 'scheduled job',
  internal: 'internal check',
  console: 'operator console',
  cli: 'command line',
  test: 'test',
};

const INVARIANT_TONE: Record<StatusInvariantState, ChipTone> = { ok: 'surf', failed: 'fault', not_applicable: 'muted', unknown: 'muted' };
const INVARIANT_LABEL: Record<StatusInvariantState, string> = { ok: 'holds', failed: 'FAILING', not_applicable: 'n/a', unknown: 'not checked' };

type Headline = { tone: 'surf' | 'fault' | 'muted'; text: string; state: 'ok' | 'failing' | 'degraded' | 'unknown' };

/** The one line at the top: the worst of what the page knows. */
export function headlineOf(data: StatusPageData): Headline {
  const down = data.services.filter((service) => service.state === 'down');
  if (data.feed === null) return { tone: 'fault', text: 'The Purse API is not answering', state: 'degraded' };
  const failed = data.feed.invariants.filter((invariant) => invariant.status === 'failed');
  if (failed.length > 0) return { tone: 'fault', text: `${failed.map((each) => each.id).join(', ')} failing`, state: 'failing' };
  if (down.length > 0) return { tone: 'fault', text: `${down.map((each) => each.label).join(' and ')} not answering`, state: 'degraded' };
  if (data.feed.status === 'unknown') return { tone: 'muted', text: 'Not checked yet', state: 'unknown' };
  return { tone: 'surf', text: 'All invariants hold', state: 'ok' };
}

export function StatusReport({ data, refreshSeconds = STATUS_REFRESH_SECONDS }: { data: StatusPageData; refreshSeconds?: number }) {
  const headline = headlineOf(data);
  const feed = data.feed;
  return (
    <main className="status" data-testid="status-page" data-status={headline.state}>
      <meta httpEquiv="refresh" content={String(refreshSeconds)} />
      <header className="status__head">
        <p className="label">Purse · public status</p>
        <h1 className="console__title">Status</h1>
        <p className="console__lede">
          This page is public. It shows whether the platform behind Sideout is healthy: the seven ledger invariants as of the last reconcile run, the recent runs, the build, and whether each service answers. It shows no tenant, player, contest or balance. It reloads every {refreshSeconds} seconds.
        </p>
      </header>

      <section className="so-card status__headline" aria-labelledby="status-headline">
        <div className="so-stat">
          <span id="status-headline" className={`so-stat__value ${headline.tone === 'muted' ? '' : `so-stat__value--${headline.tone}`}`} data-testid="status-headline">
            {headline.text}
          </span>
          <span className="label">
            {feed === null
              ? `Last attempt ${formatInstant(data.feedCheckedAt)}`
              : feed.lastRun === null
                ? 'No reconcile run has been recorded yet'
                : `Last reconcile ${formatInstant(feed.lastRun.ranAt)} by the ${SOURCE_LABEL[feed.lastRun.source]}, ${feed.lastRun.durationMs} ms`}
            {data.feedStale ? ` · shown from ${formatInstant(data.feedCheckedAt)}; the latest read did not complete` : ''}
          </span>
        </div>
      </section>

      <section className="stack" aria-labelledby="status-services">
        <h2 id="status-services" className="so-card__title">
          Services
        </h2>
        <ul className="status__services" data-testid="status-services">
          {data.services.map((service) => (
            <ServiceRow key={service.id} service={service} />
          ))}
        </ul>
      </section>

      <section className="stack" aria-labelledby="status-invariants">
        <h2 id="status-invariants" className="so-card__title">
          Invariants
        </h2>
        {feed === null ? (
          <p className="console__lede">The invariant record could not be read: the Purse API did not answer.</p>
        ) : (
          <ol className="stack" data-testid="status-invariants" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {feed.invariants.map((invariant) => (
              <li key={invariant.id} className={`invariant${invariant.status === 'failed' ? ' invariant--failed' : ''}`} data-invariant={invariant.id} data-status={invariant.status}>
                <span className="invariant__id">{invariant.id}</span>
                <div className="invariant__name">{invariant.name}</div>
                <Chip tone={INVARIANT_TONE[invariant.status]}>{INVARIANT_LABEL[invariant.status]}</Chip>
              </li>
            ))}
          </ol>
        )}
      </section>

      {feed === null ? null : (
        <section className="stack" aria-labelledby="status-runs">
          <h2 id="status-runs" className="so-card__title">
            Recent reconcile runs
          </h2>
          <div className="so-table-wrap">
            <table className="so-table" data-testid="status-runs">
              <caption className="sr-only">Recent reconcile runs, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Ran at</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Run by</th>
                  <th scope="col" className="so-num">
                    Took
                  </th>
                </tr>
              </thead>
              <tbody>
                {feed.runs.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No runs recorded yet.</td>
                  </tr>
                ) : (
                  feed.runs.map((run, index) => (
                    <tr key={`${index}-${run.ranAt}`} data-ok={run.ok ? 'true' : 'false'}>
                      <td className="so-nowrap">{formatInstant(run.ranAt)}</td>
                      <td>
                        <Chip tone={run.ok ? 'surf' : 'fault'}>{run.ok ? 'clean' : `failing: ${run.failed.join(', ')}`}</Chip>
                      </td>
                      <td>{SOURCE_LABEL[run.source]}</td>
                      <td className="so-num">{run.durationMs} ms</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="stack" aria-labelledby="status-build">
        <h2 id="status-build" className="so-card__title">
          Build
        </h2>
        <dl className="so-kv" data-testid="status-build">
          <dt>API commit</dt>
          <dd>
            <span className="so-mono">{feed === null ? '—' : feed.sha}</span>
          </dd>
          <dt>API migrations</dt>
          <dd>{feed === null ? '—' : feed.migrations.pending === 0 ? `${feed.migrations.applied} applied, none pending` : `${feed.migrations.pending} pending of ${feed.migrations.available}`}</dd>
          <dt>Active ruleset</dt>
          <dd>{feed === null ? '—' : (feed.rulesetVersion ?? 'none')}</dd>
          <dt>SDK version</dt>
          <dd>{feed === null ? '—' : feed.sdkVersion}</dd>
          <dt>Console commit</dt>
          <dd>
            <span className="so-mono">{data.consoleSha}</span>
          </dd>
        </dl>
      </section>

      <footer className="status__foot label">
        Generated {formatInstant(data.generatedAt)}. The Purse API&apos;s <span className="so-mono">/health</span> answers 503 while an invariant fails; that is what pages the operator. This page only reports.
      </footer>
    </main>
  );
}

function ServiceRow({ service }: { service: ServiceCheck }) {
  const tone: ChipTone = service.state === 'up' ? 'surf' : service.state === 'down' ? 'fault' : 'muted';
  const label = service.state === 'up' ? 'up' : service.state === 'down' ? 'DOWN' : 'not configured';
  return (
    <li className={`status__service${service.state === 'down' ? ' status__service--down' : ''}`} data-service={service.id} data-state={service.state}>
      <span className={`status__light status__light--${service.state}`} aria-hidden="true" />
      <div className="status__service-body">
        <span className="invariant__name">{service.label}</span>
        <span className="status__service-note">
          {service.note} · checked {formatInstant(service.checkedAt)}
          {service.stale ? ' (stale)' : ''}
        </span>
      </div>
      <Chip tone={tone}>{label}</Chip>
    </li>
  );
}
