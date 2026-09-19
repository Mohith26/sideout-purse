// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { Suspense, use, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRefresh, PARKED_REFRESH_RETRY_MS } from '../../src/components/motion/LiveRefresh';
import { backoffMs, FAILURES_BEFORE_FALLBACK, FALLBACK_RETRY_MS, HEALTHY_AFTER_MS, LiveConnection, liveStreamPath, type EventSourceLike, type LiveTransport } from '../../src/components/motion/live-stream';

/**
 * The browser side of live updates (docs/live.md): the connection policy on a fake
 * `EventSource` under fake timers, and the `LiveRefresh` component wiring it to the
 * router, the transport attribute and the tab's visibility.
 */
const refresh = vi.fn<() => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: () => {
      refresh();
    },
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

class FakeSource implements EventSourceLike {
  static instances: FakeSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  message(lastEventId: string, data = '{}'): void {
    this.onmessage?.(new MessageEvent('message', { data, lastEventId }));
  }
  named(type: string, lastEventId = '', data = '{}'): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data, lastEventId }));
  }
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

function connection(overrides: { createSource?: (path: string) => EventSourceLike | null; now?: () => number } = {}) {
  const events = vi.fn();
  const transports: LiveTransport[] = [];
  const conn = new LiveConnection({
    source: { kind: 'tournament', id: 'trn_1' },
    onEvent: events,
    onTransport: (t) => transports.push(t),
    pollMs: 5_000,
    createSource: overrides.createSource ?? ((path) => new FakeSource(path)),
    random: () => 0,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  const latest = (): FakeSource => {
    const source = FakeSource.instances.at(-1);
    if (source === undefined) throw new Error('no stream has been opened');
    return source;
  };
  return { conn, events, transports, latest };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.instances = [];
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset['live'];
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

describe('LiveConnection', () => {
  it('opens the stream, refreshes on every event and resync, and resumes with the last id after a bye', () => {
    const { conn, events, transports, latest } = connection();
    conn.start();
    expect(latest().url).toBe('/api/live/tournaments/trn_1');
    expect(transports).toEqual(['connecting']);
    latest().open();
    expect(transports.at(-1)).toBe('stream');
    latest().message('abc123-1');
    latest().message('abc123-2');
    latest().named('resync', 'abc123-9');
    expect(events).toHaveBeenCalledTimes(3);

    // The server closed the stream on purpose: reconnect at once, carrying the last id.
    const first = latest();
    first.named('bye', '', '{"reason":"ttl"}');
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(0);
    expect(FakeSource.instances).toHaveLength(2);
    expect(latest().url).toBe('/api/live/tournaments/trn_1?lastEventId=abc123-9');
    conn.stop();
    expect(latest().closed).toBe(true);
  });

  it('backs off between failures, falls back to polling after three, and tries the stream again later', () => {
    const { conn, events, transports, latest } = connection();
    conn.start();
    latest().fail();
    expect(latest().closed).toBe(true);
    expect(FakeSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(backoffMs(1, () => 0) - 1);
    expect(FakeSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.instances).toHaveLength(2);
    latest().fail();
    vi.advanceTimersByTime(backoffMs(2, () => 0));
    expect(FakeSource.instances).toHaveLength(3);
    latest().fail();
    expect(FAILURES_BEFORE_FALLBACK).toBe(3);
    expect(transports.at(-1)).toBe('poll');
    expect(events).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(events).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(events).toHaveBeenCalledTimes(2);
    // Polling carries on for the whole retry window, with no stream attempt.
    vi.advanceTimersByTime(FALLBACK_RETRY_MS - 10_000 - 1);
    expect(events).toHaveBeenCalledTimes(11);
    expect(FakeSource.instances).toHaveLength(3);
    // Then the stream is tried again and the polling stops.
    vi.advanceTimersByTime(1);
    expect(FakeSource.instances).toHaveLength(4);
    expect(transports.at(-1)).toBe('connecting');
    const polled = events.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    expect(events).toHaveBeenCalledTimes(polled);
    conn.stop();
  });

  it('does not count a failure after a healthy stream against the fallback', () => {
    let now = 0;
    const { conn, latest, transports } = connection({ now: () => now });
    conn.start();
    latest().open();
    now += HEALTHY_AFTER_MS;
    latest().fail();
    vi.advanceTimersByTime(backoffMs(1, () => 0));
    latest().open();
    now += HEALTHY_AFTER_MS;
    latest().fail();
    vi.advanceTimersByTime(backoffMs(1, () => 0));
    latest().open();
    now += HEALTHY_AFTER_MS;
    latest().fail();
    vi.advanceTimersByTime(backoffMs(1, () => 0));
    expect(FakeSource.instances).toHaveLength(4);
    expect(transports).not.toContain('poll');
    conn.stop();
  });

  it('polls from the start when the browser has no EventSource', () => {
    const { conn, events, transports } = connection({ createSource: () => null });
    conn.start();
    expect(transports).toEqual(['poll']);
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveBeenCalledTimes(2);
    conn.stop();
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveBeenCalledTimes(2);
  });

  it('spells the paths and the backoff', () => {
    expect(liveStreamPath({ kind: 'all' }, null)).toBe('/api/live');
    expect(liveStreamPath({ kind: 'all' }, 'a-1')).toBe('/api/live?lastEventId=a-1');
    expect(liveStreamPath({ kind: 'tournament', id: 'trn_x' }, null)).toBe('/api/live/tournaments/trn_x');
    expect(backoffMs(1, () => 0)).toBe(1_000);
    expect(backoffMs(2, () => 0)).toBe(2_000);
    expect(backoffMs(3, () => 1)).toBe(5_000);
    expect(backoffMs(20, () => 0)).toBe(30_000);
  });
});

describe('LiveRefresh', () => {
  it('streams when EventSource exists, marks the transport on <html>, refreshes on events, and pauses while hidden', () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    render(<LiveRefresh source={{ kind: 'tournament', id: 'trn_1' }} />);
    expect(FakeSource.instances).toHaveLength(1);
    expect(document.documentElement.dataset['live']).toBe('connecting');
    act(() => FakeSource.instances[0]?.open());
    expect(document.documentElement.dataset['live']).toBe('stream');
    act(() => FakeSource.instances[0]?.message('e-1'));
    expect(refresh).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(FakeSource.instances[0]?.closed).toBe(true);
    expect(document.documentElement.dataset['live']).toBeUndefined();

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // One refresh catches up on whatever happened while hidden, and a fresh stream opens.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(FakeSource.instances).toHaveLength(2);
    cleanup();
    expect(FakeSource.instances[1]?.closed).toBe(true);
    expect(document.documentElement.dataset['live']).toBeUndefined();
  });

  /** One poll tick, with React settling the refresh's transition afterwards as it would between real ticks. */
  const tick = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('polls without a source, and when the browser has no EventSource', () => {
    render(<LiveRefresh intervalMs={1_000} />);
    expect(document.documentElement.dataset['live']).toBe('poll');
    for (let i = 0; i < 3; i += 1) tick(1_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    cleanup();
    refresh.mockReset();

    render(<LiveRefresh source={{ kind: 'all' }} intervalMs={1_000} />);
    expect(FakeSource.instances).toHaveLength(0);
    expect(document.documentElement.dataset['live']).toBe('poll');
    tick(1_000);
    tick(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps a retry ticking while a refresh is pending, so a render the router parks is re-attempted', () => {
    // The router suspends the tree on the refresh's promise inside a transition; here the
    // promise never settles until the test says so, which is what a parked render looks like
    // from this component (`isPending` stays true). The retry is a plain state update on an
    // interval of PARKED_REFRESH_RETRY_MS; React's response to it (clearing the suspended lanes
    // and re-attempting the render) is the browser's job, checked by the Playwright flow.
    let setRouterState: (state: number | Promise<number>) => void = () => undefined;
    let resolveRefresh: (value: number) => void = () => undefined;
    function Router({ state }: { state: number | Promise<number> }) {
      return <output>{typeof state === 'number' ? state : use(state)}</output>;
    }
    function App() {
      const [state, setState] = useState<number | Promise<number>>(0);
      setRouterState = setState;
      return (
        <Suspense fallback={<output>loading</output>}>
          <Router state={state} />
          <LiveRefresh source={{ kind: 'tournament', id: 'trn_1' }} />
        </Suspense>
      );
    }
    refresh.mockImplementation(() => {
      setRouterState(
        new Promise<number>((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    const { container } = render(<App />);
    const source = FakeSource.instances[0];
    if (source === undefined) throw new Error('no stream');
    act(() => source.open());
    const retries = () => intervals.mock.calls.filter((call) => call[1] === PARKED_REFRESH_RETRY_MS);
    expect(retries()).toHaveLength(0);

    act(() => source.message('e-1'));
    expect(refresh).toHaveBeenCalledTimes(1);
    // Suspended: the old content stays and the retry interval is armed.
    expect(container.querySelector('output')?.textContent).toBe('0');
    expect(retries()).toHaveLength(1);
    const handle = intervals.mock.results.at(-1)?.value as unknown;
    expect(cleared.mock.calls.some((call) => call[0] === handle)).toBe(false);
    tick(PARKED_REFRESH_RETRY_MS * 3);
    expect(cleared.mock.calls.some((call) => call[0] === handle)).toBe(false);

    // Leaving the page disarms it too.
    cleanup();
    expect(cleared.mock.calls.some((call) => call[0] === handle)).toBe(true);
    resolveRefresh(1);
    refresh.mockReset();
  });

  it('disarms the retry as soon as a refresh settles', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    render(<LiveRefresh source={{ kind: 'tournament', id: 'trn_1' }} />);
    const source = FakeSource.instances[0];
    if (source === undefined) throw new Error('no stream');
    act(() => source.open());
    act(() => source.message('e-1'));
    expect(refresh).toHaveBeenCalledTimes(1);
    const armed = intervals.mock.calls.findIndex((call) => call[1] === PARKED_REFRESH_RETRY_MS);
    expect(armed).toBeGreaterThanOrEqual(0);
    expect(intervals.mock.calls.filter((call) => call[1] === PARKED_REFRESH_RETRY_MS)).toHaveLength(1);
    const handle = intervals.mock.results[armed]?.value as unknown;
    expect(cleared.mock.calls.some((call) => call[0] === handle)).toBe(true);
  });

  it('coalesces events that arrive while a refresh is in flight into one more refresh', () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    render(<LiveRefresh source={{ kind: 'tournament', id: 'trn_1' }} />);
    const source = FakeSource.instances[0];
    if (source === undefined) throw new Error('no stream');
    act(() => source.open());
    // Three events before React can settle the first transition: the first refresh, then exactly one for the rest.
    act(() => {
      source.message('e-1');
      source.message('e-2');
      source.message('e-3');
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => source.message('e-4'));
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
