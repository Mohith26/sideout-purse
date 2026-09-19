'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { LiveConnection, type LiveSource, type LiveTransport } from './live-stream';

/** Decision D11: live figures poll at five seconds; the cadence the stream falls back to. */
export const LIVE_POLL_MS = 5_000;

/** A refresh that has not settled after this long is treated as done, so a stuck transition can never stop the next one. */
const STALE_REFRESH_MS = 15_000;

/**
 * While a refresh is in flight, a plain state update at this cadence. Next 15.5's app
 * router suspends the whole tree on the refresh's promise inside a transition, and in a
 * production build the render it parked is sometimes never woken once that promise settles
 * (vercel/next.js#98305: `suspendedLanes` set, `pingedLanes` never): the page keeps the old
 * figures for good. Any non-idle update clears React's suspended lanes and retries the
 * parked render, which then commits at once. A normal refresh settles in tens of
 * milliseconds and never sees the first tick; a parked one is retried within a quarter
 * second. Remove once the router is on a release that removed the code path (Next 16).
 */
export const PARKED_REFRESH_RETRY_MS = 250;

/** The attribute on `<html>` that tells the design system which transport is carrying live figures (`.so-live-dot` reads it). */
export const LIVE_TRANSPORT_ATTRIBUTE = 'data-live';

export type { LiveSource };

/**
 * Re-render the server components while a page is showing live figures, so standings and
 * scores track the rows without the client holding a second copy of the data (decision
 * D11). With a `source`, a Server-Sent Events stream on `/api/live/*` drives the refresh
 * (docs/live.md): every event re-renders once, refreshes are coalesced so at most one is
 * in flight, the stream pauses while the tab is hidden and reconnects (after one refresh)
 * when it returns, and the phase 8 polling is the fallback when the browser has no
 * `EventSource` or the stream keeps failing. Without a `source` it polls, as before.
 * Fresh numbers are content, not motion, so reduced-motion preferences do not stop it.
 * Either way a refresh the router parks is retried (`PARKED_REFRESH_RETRY_MS`).
 */
export function LiveRefresh({ source, intervalMs = LIVE_POLL_MS }: { source?: LiveSource; intervalMs?: number }) {
  const router = useRouter();
  // The latest router, read from the stream's callbacks; a test's router double is a fresh object per render.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const queued = useRef(false);
  const startedAt = useRef(0);

  const refresh = useCallback(() => {
    const now = Date.now();
    if (inFlight.current && now - startedAt.current < STALE_REFRESH_MS) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    queued.current = false;
    startedAt.current = now;
    startTransition(() => routerRef.current.refresh());
  }, []);

  // The transition settled: run the refresh an event asked for meanwhile, if any.
  useEffect(() => {
    if (isPending || !inFlight.current) return;
    inFlight.current = false;
    if (queued.current) refresh();
  }, [isPending, refresh]);

  // The watchdog for a parked refresh (see PARKED_REFRESH_RETRY_MS): a state update nobody
  // reads, whose only job is to make React retry the suspended render.
  const [, retry] = useState(0);
  useEffect(() => {
    if (!isPending) return;
    const timer = setInterval(() => retry((n) => n + 1), PARKED_REFRESH_RETRY_MS);
    return () => clearInterval(timer);
  }, [isPending]);

  // The source is compared by value: a server component renders a fresh object each time.
  const sourceKey = source === undefined ? null : source.kind === 'all' ? 'all' : `tournament:${source.id}`;
  useEffect(() => {
    const parsed = parseSourceKey(sourceKey);
    if (parsed === null) return pollingEffect(refresh, intervalMs);
    return streamEffect(parsed, refresh, intervalMs);
  }, [sourceKey, refresh, intervalMs]);

  return null;
}

function parseSourceKey(key: string | null): LiveSource | null {
  if (key === null) return null;
  if (key === 'all') return { kind: 'all' };
  return { kind: 'tournament', id: key.slice('tournament:'.length) };
}

function setTransport(transport: LiveTransport | null): void {
  if (transport === null) delete document.documentElement.dataset['live'];
  else document.documentElement.dataset['live'] = transport;
}

function pollingEffect(refresh: () => void, intervalMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    timer ??= setInterval(refresh, intervalMs);
    setTransport('poll');
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      refresh();
      start();
    } else {
      stop();
    }
  };
  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
    setTransport(null);
  };
}

function streamEffect(source: LiveSource, refresh: () => void, pollMs: number): () => void {
  let connection: LiveConnection | null = null;
  const start = () => {
    if (connection !== null) return;
    connection = new LiveConnection({ source, onEvent: refresh, onTransport: setTransport, pollMs });
    connection.start();
  };
  const stop = () => {
    connection?.stop();
    connection = null;
    setTransport(null);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      // Whatever happened while the tab was hidden, one render catches up; the stream carries on from there.
      refresh();
      start();
    } else {
      stop();
    }
  };
  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
