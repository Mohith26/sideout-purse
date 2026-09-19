import { randomBytes } from 'node:crypto';

import type { Logger } from '@repo/logger';
import type { Sql } from '@repo/db';

import { database } from '../../db/client';
import { env } from '../../env';
import { logger } from '../../lib/logger';
import { channelName, eventId, livePayloadSchema, parseEventId, type LiveChannel, type LiveEvent, type LiveSignal } from './events';

/**
 * The in-process leg of live fan-out (docs/live.md). One bus per process holds, per
 * channel it is serving, a Postgres `LISTEN` on the channel's name, the subscribers
 * (open streams) and a bounded ring of the events it has delivered. Everything the bus
 * delivers came in as a notification: the publisher (`publish.ts`) never calls it, so a
 * screen served by this process and one served by another see the same sequence.
 *
 * A channel is listened to while it has subscribers and for `lingerMs` after the last
 * one leaves, so a browser that reconnects after a blip resumes from the ring instead of
 * re-rendering. The ring is what `Last-Event-ID` resumes from: an id is the channel's
 * epoch (random, minted when listening starts and again on every reconnect of the
 * listening connection, since notifications during the gap were lost) and a sequence
 * within it. An id from another epoch, or one the ring has evicted, cannot be resumed
 * and the subscriber is told to `resync` (re-render once) instead.
 *
 * postgres.js keeps the `LISTEN` on a dedicated connection of the app's pool and
 * reconnects it with backoff; `onlisten` runs on every (re)establishment, which is what
 * mints the new epoch.
 */
export type LiveDelivery = { type: 'event'; event: LiveEvent } | { type: 'signal'; signal: LiveSignal };
export type LiveHandler = (delivery: LiveDelivery) => void;

export type SubscribeOptions = {
  /** The `Last-Event-ID` the browser sent, if any. */
  lastEventId?: string | null | undefined;
  /** The client address, for the per-address bound. */
  address: string;
  /** Refuse (with `LiveBusy`) rather than exceed these. */
  caps?: { maxStreams: number; maxStreamsPerAddress: number } | undefined;
};

export type Subscription = { unsubscribe: () => void };

/** The bus is full for this process or this address; the route answers 429 with `Retry-After`. */
export class LiveBusy extends Error {
  override readonly name = 'LiveBusy';
  constructor(readonly scope: 'process' | 'address') {
    super(scope === 'process' ? 'This instance is serving as many live streams as it may.' : 'Too many live streams are open from this address.');
  }
}

type Subscriber = { handler: LiveHandler; address: string };

type ChannelState = {
  name: string;
  epoch: string;
  seq: number;
  ring: LiveEvent[];
  subscribers: Set<Subscriber>;
  /** Resolves once `LISTEN` is established; the subscribe waits for it so no event slips past between resume and live delivery. */
  listening: Promise<{ unlisten: () => Promise<void> }>;
  /** How many times `onlisten` has fired; the second and later are reconnects. */
  established: number;
  linger: ReturnType<typeof setTimeout> | null;
};

export type LiveBusOptions = {
  sql: Sql;
  log: Logger;
  /** Events kept per channel for resumption. */
  ringSize?: number;
  /** How long a channel stays listened to after its last subscriber leaves. */
  lingerMs?: number;
};

export const DEFAULT_RING_SIZE = 256;
export const DEFAULT_LINGER_MS = 30_000;

function mintEpoch(): string {
  return randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
}

export class LiveBus {
  private readonly channels = new Map<string, ChannelState>();
  private readonly byAddress = new Map<string, number>();
  private open = 0;
  private closed = false;

  constructor(private readonly options: LiveBusOptions) {}

  /** Open streams on this process. */
  get openStreams(): number {
    return this.open;
  }

  streamsFrom(address: string): number {
    return this.byAddress.get(address) ?? 0;
  }

  /** Channels currently listened to (for tests and the health of the process). */
  get listeningTo(): string[] {
    return [...this.channels.keys()];
  }

  async subscribe(channel: LiveChannel, handler: LiveHandler, options: SubscribeOptions): Promise<Subscription> {
    if (this.closed) throw new Error('the live bus is closed');
    const caps = options.caps;
    if (caps !== undefined) {
      if (this.open >= caps.maxStreams) throw new LiveBusy('process');
      if (this.streamsFrom(options.address) >= caps.maxStreamsPerAddress) throw new LiveBusy('address');
    }
    // Reserve the slot before the first await, so two arrivals cannot both pass the check.
    this.open += 1;
    this.byAddress.set(options.address, this.streamsFrom(options.address) + 1);
    const subscriber: Subscriber = { handler, address: options.address };
    let state: ChannelState;
    try {
      state = this.channel(channel);
      if (state.linger !== null) {
        clearTimeout(state.linger);
        state.linger = null;
      }
      await state.listening;
    } catch (error) {
      this.release(subscriber);
      throw error;
    }
    if (this.closed) {
      this.release(subscriber);
      throw new Error('the live bus is closed');
    }
    const resume = resumeFrom(state, options.lastEventId ?? null);
    state.subscribers.add(subscriber);
    // Delivered synchronously, before any notification can interleave.
    for (const delivery of resume) deliver(subscriber, delivery, this.options.log);
    return {
      unsubscribe: () => {
        if (!state.subscribers.delete(subscriber)) return;
        this.release(subscriber);
        if (state.subscribers.size === 0) this.scheduleUnlisten(state);
      },
    };
  }

  /** Tell every stream to reconnect elsewhere and stop listening: process shutdown, or a test's teardown. */
  async close(): Promise<void> {
    this.closed = true;
    const states = [...this.channels.values()];
    this.channels.clear();
    for (const state of states) {
      if (state.linger !== null) clearTimeout(state.linger);
      for (const subscriber of state.subscribers) deliver(subscriber, { type: 'signal', signal: { kind: 'bye', reason: 'shutdown' } }, this.options.log);
      state.subscribers.clear();
      await this.unlisten(state);
    }
    this.open = 0;
    this.byAddress.clear();
  }

  private release(subscriber: Subscriber): void {
    this.open = Math.max(0, this.open - 1);
    const remaining = this.streamsFrom(subscriber.address) - 1;
    if (remaining <= 0) this.byAddress.delete(subscriber.address);
    else this.byAddress.set(subscriber.address, remaining);
  }

  private channel(channel: LiveChannel): ChannelState {
    const name = channelName(channel);
    const existing = this.channels.get(name);
    if (existing !== undefined) return existing;
    const state: ChannelState = { name, epoch: mintEpoch(), seq: 0, ring: [], subscribers: new Set(), listening: Promise.resolve({ unlisten: () => Promise.resolve() }), established: 0, linger: null };
    state.listening = this.options.sql.listen(
      name,
      (payload) => this.onNotify(state, payload),
      () => this.onListen(state),
    );
    // A failed LISTEN (the database is unreachable) must not linger as a channel nobody can join.
    state.listening.catch(() => this.channels.delete(name));
    this.channels.set(name, state);
    return state;
  }

  private onListen(state: ChannelState): void {
    state.established += 1;
    if (state.established === 1 || this.channels.get(state.name) !== state) return;
    // The listening connection came back after a drop: whatever was notified meanwhile is
    // gone, so the ring cannot resume across it. New epoch, and every open stream re-renders.
    state.epoch = mintEpoch();
    state.seq = 0;
    state.ring.length = 0;
    this.options.log.warn('live listener reconnected; streams resync', { channel: state.name, subscribers: state.subscribers.size });
    for (const subscriber of state.subscribers) deliver(subscriber, { type: 'signal', signal: { kind: 'resync', id: eventId(state.epoch, state.seq) } }, this.options.log);
  }

  private onNotify(state: ChannelState, raw: string): void {
    // A stale callback (postgres.js re-registers listeners on reconnect) for a channel this bus has dropped.
    if (this.channels.get(state.name) !== state) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.log.warn('live notification is not JSON', { channel: state.name });
      return;
    }
    const payload = livePayloadSchema.safeParse(parsed);
    if (!payload.success) {
      this.options.log.warn('live notification has an unknown shape', { channel: state.name });
      return;
    }
    state.seq += 1;
    const event: LiveEvent = { ...payload.data, id: eventId(state.epoch, state.seq), seq: state.seq };
    state.ring.push(event);
    const size = this.options.ringSize ?? DEFAULT_RING_SIZE;
    if (state.ring.length > size) state.ring.splice(0, state.ring.length - size);
    for (const subscriber of state.subscribers) deliver(subscriber, { type: 'event', event }, this.options.log);
  }

  private scheduleUnlisten(state: ChannelState): void {
    if (state.linger !== null) clearTimeout(state.linger);
    const linger = this.options.lingerMs ?? DEFAULT_LINGER_MS;
    state.linger = setTimeout(() => {
      state.linger = null;
      if (state.subscribers.size > 0 || this.channels.get(state.name) !== state) return;
      this.channels.delete(state.name);
      void this.unlisten(state);
    }, linger);
    // A lingering channel must not keep a process (a test worker) alive on its own.
    state.linger.unref();
  }

  private async unlisten(state: ChannelState): Promise<void> {
    try {
      const meta = await state.listening;
      await meta.unlisten();
    } catch (error) {
      this.options.log.warn('live unlisten failed', { channel: state.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function deliver(subscriber: Subscriber, delivery: LiveDelivery, log: Logger): void {
  try {
    subscriber.handler(delivery);
  } catch (error) {
    log.warn('live subscriber threw', { message: error instanceof Error ? error.message : String(error) });
  }
}

/** What to send a subscriber first: the events after the id it last saw, a `resync` when that is impossible, nothing for a fresh stream. */
function resumeFrom(state: ChannelState, lastEventId: string | null): LiveDelivery[] {
  const parsed = parseEventId(lastEventId);
  if (parsed === null) return [];
  const resync: LiveDelivery = { type: 'signal', signal: { kind: 'resync', id: eventId(state.epoch, state.seq) } };
  if (parsed.epoch !== state.epoch) return [resync];
  if (parsed.seq >= state.seq) return [];
  const oldest = state.ring[0];
  if (oldest === undefined || oldest.seq > parsed.seq + 1) return [resync];
  return state.ring.filter((event) => event.seq > parsed.seq).map((event) => ({ type: 'event', event }));
}

/**
 * The process-wide bus, on the app's pool. Cached on `globalThis` like the pool itself so
 * `next dev` keeps one set of listeners across reloads. On `SIGTERM` every open stream is
 * told `bye` so browsers reconnect to the instance that replaces this one.
 */
const globalBus = globalThis as typeof globalThis & { __sideoutLiveBus?: LiveBus };

export function liveBus(): LiveBus {
  if (globalBus.__sideoutLiveBus === undefined) {
    const bus = new LiveBus({ sql: database().sql, log: logger(env().logLevel) });
    globalBus.__sideoutLiveBus = bus;
    process.once('SIGTERM', () => {
      void bus.close();
    });
  }
  return globalBus.__sideoutLiveBus;
}

/** Drop the process bus after telling its streams goodbye (tests). */
export async function closeLiveBus(): Promise<void> {
  const bus = globalBus.__sideoutLiveBus;
  delete globalBus.__sideoutLiveBus;
  if (bus !== undefined) await bus.close();
}
