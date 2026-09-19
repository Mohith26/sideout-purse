/**
 * The browser side of live updates (docs/live.md), with no React in it so the policy can
 * be tested on its own: an `EventSource` on the tournament's (or the home feed's) stream,
 * a refresh for every event, reconnection with backoff, and polling as the fallback when
 * the browser has no `EventSource` or the stream keeps failing.
 *
 * Failures are counted per connection attempt: a stream that lived for `HEALTHY_AFTER_MS`
 * before dropping was a good connection (a deploy, a proxy timeout), so the count starts
 * over; three short-lived failures in a row mean the transport is not working from here
 * (a proxy that buffers, a 429 from a busy instance) and the page polls instead for
 * `FALLBACK_RETRY_MS` before trying the stream again. `bye` is the server closing the
 * stream on purpose (its lifetime is up, or it is shutting down): the browser reconnects at
 * once, with a little jitter so a deploy does not turn every open page into one burst.
 */
export type LiveSource = { kind: 'tournament'; id: string } | { kind: 'all' };

export type LiveTransport = 'connecting' | 'stream' | 'poll';

/** The part of `EventSource` the connection uses; a test's fake implements this much. */
export type EventSourceLike = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
};

export type LiveConnectionOptions = {
  source: LiveSource;
  /** An event, a resync, or a poll tick: re-render from the server. */
  onEvent: () => void;
  onTransport: (transport: LiveTransport) => void;
  /** The polling cadence while the stream is unavailable (decision D11's five seconds). */
  pollMs: number;
  /** Opens the stream; `null` means this browser has no `EventSource`. Defaults to the global one. */
  createSource?: (path: string) => EventSourceLike | null;
  random?: () => number;
  now?: () => number;
};

export const FAILURES_BEFORE_FALLBACK = 3;
export const FALLBACK_RETRY_MS = 60_000;
export const HEALTHY_AFTER_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const BYE_RECONNECT_JITTER_MS = 1_000;

export function liveStreamPath(source: LiveSource, lastEventId: string | null): string {
  const path = source.kind === 'all' ? '/api/live' : `/api/live/tournaments/${encodeURIComponent(source.id)}`;
  // A hand-made reconnection carries no `Last-Event-ID` header; the query string is the same thing to the server.
  return lastEventId === null ? path : `${path}?lastEventId=${encodeURIComponent(lastEventId)}`;
}

/** Exponential from one second, capped at thirty, with up to a quarter of jitter so reconnects spread out. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(base + base * 0.25 * random());
}

function defaultCreateSource(path: string): EventSourceLike | null {
  if (typeof EventSource === 'undefined') return null;
  return new EventSource(path);
}

export class LiveConnection {
  private source: EventSourceLike | null = null;
  private lastEventId: string | null = null;
  private failures = 0;
  private openedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly options: LiveConnectionOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSource();
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.closeSource();
    const create = this.options.createSource ?? defaultCreateSource;
    const source = create(liveStreamPath(this.options.source, this.lastEventId));
    if (source === null) {
      this.fallback(null);
      return;
    }
    this.source = source;
    this.options.onTransport('connecting');
    source.onopen = () => {
      this.openedAt = this.now();
      this.options.onTransport('stream');
    };
    source.onmessage = (event) => {
      this.lastEventId = event.lastEventId === '' ? this.lastEventId : event.lastEventId;
      this.options.onEvent();
    };
    source.addEventListener('resync', (event) => {
      this.lastEventId = event.lastEventId === '' ? this.lastEventId : event.lastEventId;
      this.options.onEvent();
    });
    source.addEventListener('bye', () => {
      if (this.source !== source) return;
      this.closeSource();
      this.failures = 0;
      this.schedule(Math.round(BYE_RECONNECT_JITTER_MS * this.random()));
    });
    source.onerror = () => {
      if (this.source !== source) return;
      const lived = this.openedAt === null ? 0 : this.now() - this.openedAt;
      this.closeSource();
      this.failures = lived >= HEALTHY_AFTER_MS ? 1 : this.failures + 1;
      if (this.failures >= FAILURES_BEFORE_FALLBACK) this.fallback(FALLBACK_RETRY_MS);
      else this.schedule(backoffMs(this.failures, () => this.random()));
    };
  }

  /** Poll at the D11 cadence; with a retry delay, try the stream again after it. */
  private fallback(retryAfterMs: number | null): void {
    this.options.onTransport('poll');
    this.poll = setInterval(() => this.options.onEvent(), this.options.pollMs);
    if (retryAfterMs !== null) {
      this.timer = setTimeout(() => {
        this.failures = 0;
        this.connect();
      }, retryAfterMs);
    }
  }

  private schedule(delayMs: number): void {
    this.options.onTransport('connecting');
    this.timer = setTimeout(() => this.connect(), delayMs);
  }

  private closeSource(): void {
    if (this.source === null) return;
    const source = this.source;
    this.source = null;
    this.openedAt = null;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.poll !== null) clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private random(): number {
    return (this.options.random ?? Math.random)();
  }
}
