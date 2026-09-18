'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip } from '@sideout/ui';
import type { ApiError, ReconcileResource } from '@purse/types';

import { api } from '../lib/client';
import { formatInstant } from '../lib/format';
import { ErrorNotice } from './ErrorNotice';

/**
 * Runs `reconcile()` through the console API on mount, on demand, and on a timer while
 * the panel is open (`refreshMs`, 60 seconds by default). Every invariant is listed
 * every time with its status and its detail sentence; a failed one is red and the
 * headline turns red with it. The last run time is shown so a stale panel is visible.
 */
export const DEFAULT_REFRESH_MS = 60_000;

export function InvariantPanel({ initial, refreshMs = DEFAULT_REFRESH_MS, autoRefresh = true }: { initial: ReconcileResource | null; refreshMs?: number; autoRefresh?: boolean }) {
  const [report, setReport] = useState<ReconcileResource | null>(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState(autoRefresh);
  const inFlight = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const request = api.get<ReconcileResource>('/reconcile', { signal: controller.signal });
      // State changes only after the request is in flight, so the timer and the mount effect may call this directly.
      await Promise.resolve();
      if (!controller.signal.aborted) setRunning(true);
      const res = await request;
      if (controller.signal.aborted) return;
      if (res.ok) {
        setReport(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError({ type: 'internal_error', code: 'network', message: 'The console could not reach its server' });
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setRunning(false);
      }
    }
  }, []);

  useEffect(() => {
    // The first run when the page had no report: scheduled, not synchronous, so the effect itself sets no state.
    if (initial !== null) return;
    queueMicrotask(() => {
      void run();
    });
  }, [initial, run]);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => {
      void run();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [live, refreshMs, run]);

  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  const failed = report?.invariants.filter((each) => each.status === 'failed') ?? [];
  const ok = report?.ok === true;
  return (
    <section className="stack" aria-live="polite" data-testid="invariant-panel" data-status={report === null ? 'unknown' : ok ? 'ok' : 'failed'}>
      <div className="so-card">
        <div className="so-card__head">
          <div className="so-stat">
            <span className={`so-stat__value ${report === null ? '' : ok ? 'so-stat__value--surf' : 'so-stat__value--fault'}`}>{report === null ? 'Not run' : ok ? 'All invariants hold' : `${failed.length} invariant${failed.length === 1 ? '' : 's'} failed`}</span>
            <span className="label">
              {report === null ? 'No report yet' : `Last run ${formatInstant(report.ranAt)} in ${report.durationMs} ms`}
              {running ? ' · running…' : ''}
            </span>
          </div>
          <div className="so-actions">
            <span className="row" style={{ gap: 'var(--space-1)' }}>
              <span className={`live-dot${report !== null && !ok ? ' live-dot--fault' : ''}`} aria-hidden="true" style={{ opacity: live ? 1 : 0.3 }} />
              <span className="label">{live ? `every ${Math.round(refreshMs / 1000)}s` : 'paused'}</span>
            </span>
            <Button small onClick={() => setLive((value) => !value)}>
              {live ? 'Pause' : 'Resume'}
            </Button>
            <Button small variant="primary" onClick={run} disabled={running}>
              Run now
            </Button>
          </div>
        </div>
        {error === null ? null : <ErrorNotice error={error} title="The last run did not complete" />}
      </div>
      {report === null ? null : (
        <ol className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {report.invariants.map((invariant) => (
            <li key={invariant.id} className={`invariant${invariant.status === 'failed' ? ' invariant--failed' : ''}`} data-invariant={invariant.id} data-status={invariant.status}>
              <span className="invariant__id">{invariant.id}</span>
              <div>
                <div className="invariant__name">{invariant.name}</div>
                <p className="invariant__detail">{invariant.detail}</p>
                {invariant.notApplicableUntil === undefined ? null : <p className="invariant__detail">Not applicable until {invariant.notApplicableUntil}.</p>}
              </div>
              <Chip tone={invariant.status === 'ok' ? 'surf' : invariant.status === 'failed' ? 'fault' : 'muted'}>{invariant.status === 'ok' ? 'holds' : invariant.status === 'failed' ? 'FAILED' : 'n/a'}</Chip>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
