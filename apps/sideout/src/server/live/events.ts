import { z } from 'zod';

/**
 * What a live event is (docs/live.md). An event says that something about a tournament
 * changed and roughly what: it never carries a payload a screen renders. The screen
 * re-renders from the server on receipt, so the count-up, the FLIP reorder and the bracket
 * draw keep animating the difference between two server renders (decision D11, phase 8),
 * and a stale or reordered event can at worst cause one refresh too many.
 *
 * Kinds: `score` (a scoreline was recorded or the consensus moved), `match` (a match's
 * status or its teams changed: on the sand, awaiting scores, final, disputed, forfeited,
 * the winner placed in the next match), `standings` (a result became final, so the pool
 * or bracket standings may have moved) and `state` (the tournament's status changed).
 */
export const LIVE_KINDS = ['score', 'match', 'standings', 'state'] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

/** What a writer emits; the publisher stamps the time and the bus the sequence. */
export type LiveEventInput = { tournamentId: string; kind: LiveKind; matchId?: string | null };

/** The NOTIFY payload: the input plus when it was published. */
export const livePayloadSchema = z.object({
  tournamentId: z.string().min(1),
  kind: z.enum(LIVE_KINDS),
  matchId: z.string().min(1).nullable(),
  at: z.string().min(1),
});
export type LivePayload = z.infer<typeof livePayloadSchema>;

/** What a subscriber receives: the payload with the stream's id and per-channel sequence. */
export type LiveEvent = LivePayload & { id: string; seq: number };

/** The control messages a stream carries besides events: `resync` (re-render once; the ring could not resume) and `bye` (the server closed the stream on purpose; reconnect at once). */
export type LiveSignal = { kind: 'resync'; id: string } | { kind: 'bye'; reason: 'ttl' | 'shutdown' };

/** Every channel name is the app's prefix and the tournament id (or nothing, for the feed of every tournament): under Postgres's 63-byte identifier limit for a `trn_` id. */
export const LIVE_CHANNEL_PREFIX = 'sideout_live';

export type LiveChannel = { kind: 'tournament'; tournamentId: string } | { kind: 'all' };

export function channelName(channel: LiveChannel): string {
  return channel.kind === 'all' ? LIVE_CHANNEL_PREFIX : `${LIVE_CHANNEL_PREFIX}:${channel.tournamentId}`;
}

/** An event id on the wire: the channel's epoch (random per process and per continuous listening period) and its sequence within it. */
export function eventId(epoch: string, seq: number): string {
  return `${epoch}-${seq}`;
}

export function parseEventId(value: string | null | undefined): { epoch: string; seq: number } | null {
  if (value === null || value === undefined) return null;
  const match = /^([A-Za-z0-9]{6,32})-(\d{1,12})$/.exec(value.trim());
  if (match === null) return null;
  return { epoch: match[1] ?? '', seq: Number(match[2]) };
}

/** Two inputs that would tell a screen the same thing. */
export function sameEvent(a: LiveEventInput, b: LiveEventInput): boolean {
  return a.tournamentId === b.tournamentId && a.kind === b.kind && (a.matchId ?? null) === (b.matchId ?? null);
}
