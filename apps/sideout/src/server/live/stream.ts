import type { Logger } from '@repo/logger';

import type { LiveEnv } from '../../env';
import { fail } from '../http/respond';
import { failure } from '../http/errors';
import { LiveBusy, type LiveBus, type LiveDelivery } from './bus';
import type { LiveChannel } from './events';

/**
 * A live stream as a `Response` (docs/live.md): Server-Sent Events over a `ReadableStream`
 * the route handler returns. The stream opens with a `retry` hint and a comment, then
 * carries each delivery as one frame: an event as an unnamed `message` with its `id` and
 * a JSON body, `resync` and `bye` as named events. A comment line goes out every
 * `heartbeatMs` so a proxy does not close a quiet stream, and after `streamTtlMs` the
 * server says `bye` and closes it, so no connection outlives a deploy by much and the
 * browser spreads itself over the instances again.
 *
 * The response headers are what a proxy in front of Next needs: `no-transform` also keeps
 * Next's own compression from buffering the body, and `X-Accel-Buffering: no` tells nginx
 * and the hosts built on it to pass bytes through.
 *
 * Load is shed before the stream opens: past `maxStreams` for the process or
 * `maxStreamsPerAddress` for the caller, the answer is a 429 with `Retry-After`, which an
 * `EventSource` reports as an error and the client turns into polling.
 */
export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

/** What the browser is told to wait before its own reconnect (the app's client manages backoff itself). */
export const RETRY_HINT_MS = 3_000;
export const RETRY_AFTER_SECONDS = 5;

export type StreamInput = {
  channel: LiveChannel;
  lastEventId: string | null;
  address: string;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
};

export type StreamDeps = { bus: LiveBus; log: Logger; config: LiveEnv };

/** One SSE frame for a delivery. */
export function frame(delivery: LiveDelivery): string {
  if (delivery.type === 'event') {
    const { event } = delivery;
    const body = { tournamentId: event.tournamentId, kind: event.kind, matchId: event.matchId, seq: event.seq, at: event.at };
    return `id: ${event.id}\ndata: ${JSON.stringify(body)}\n\n`;
  }
  const { signal } = delivery;
  if (signal.kind === 'resync') return `id: ${signal.id}\nevent: resync\ndata: {}\n\n`;
  return `event: bye\ndata: ${JSON.stringify({ reason: signal.reason })}\n\n`;
}

export async function openLiveStream(deps: StreamDeps, input: StreamInput): Promise<Response> {
  const { bus, log, config } = deps;
  const encoder = new TextEncoder();
  // Deliveries that arrive (the resumed ones do, synchronously) before the stream has started are held here.
  let pending: LiveDelivery[] | null = [];
  let write: (chunk: string) => void = () => undefined;
  const onDelivery = (delivery: LiveDelivery) => {
    if (pending !== null) {
      pending.push(delivery);
      return;
    }
    write(frame(delivery));
    if (delivery.type === 'signal' && delivery.signal.kind === 'bye') finish();
  };
  let finish: () => void = () => undefined;

  let subscription: { unsubscribe: () => void };
  try {
    subscription = await bus.subscribe(input.channel, onDelivery, {
      lastEventId: input.lastEventId,
      address: input.address,
      caps: { maxStreams: config.maxStreams, maxStreamsPerAddress: config.maxStreamsPerAddress },
    });
  } catch (error) {
    if (error instanceof LiveBusy) {
      log.warn('live stream refused', { scope: error.scope, address: input.address, open: bus.openStreams });
      return fail(failure.rateLimited(error.scope === 'process' ? 'live_busy' : 'live_too_many_streams', error.message).error, 429, { headers: { 'retry-after': String(RETRY_AFTER_SECONDS) } });
    }
    log.error('live stream could not subscribe', { message: error instanceof Error ? error.message : String(error) });
    return fail(failure.internal('live_unavailable', 'Live updates are unavailable right now.').error, 503, { headers: { 'retry-after': String(RETRY_AFTER_SECONDS) } });
  }
  if (input.signal.aborted) {
    subscription.unsubscribe();
    return new Response(null, { status: 204 });
  }

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let ttl: ReturnType<typeof setTimeout> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        if (ttl !== null) clearTimeout(ttl);
        subscription.unsubscribe();
        input.signal.removeEventListener('abort', finish);
        try {
          controller.close();
        } catch (error) {
          // Already closed by the consumer; nothing is left to release.
          log.debug('live stream close after cancel', { message: error instanceof Error ? error.message : String(error) });
        }
      };
      write = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          log.debug('live stream write failed; closing', { message: error instanceof Error ? error.message : String(error) });
          finish();
        }
      };
      input.signal.addEventListener('abort', finish);
      write(`retry: ${RETRY_HINT_MS}\n: connected\n\n`);
      const held = pending ?? [];
      pending = null;
      for (const delivery of held) onDelivery(delivery);
      heartbeat = setInterval(() => write(': heartbeat\n\n'), config.heartbeatMs);
      ttl = setTimeout(() => onDelivery({ type: 'signal', signal: { kind: 'bye', reason: 'ttl' } }), config.streamTtlMs);
    },
    cancel() {
      finish();
    },
  });
  return new Response(stream, { status: 200, headers: { ...STREAM_HEADERS } });
}
