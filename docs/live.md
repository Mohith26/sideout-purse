# Live scoring over Server-Sent Events

Decision D11 chose polling for v1 and Server-Sent Events as the polish upgrade; this is
that upgrade (system spec section 12, item 3). Every screen that shows live figures (the
home strip, the tournament tabs of a live event, an open match, the organizer's live board
and the dispute queue) holds one stream open and re-renders from the server on each event.
Polling at five seconds is kept as the fallback, and nothing about what a screen renders
changed: the count-up, the FLIP reorder and the bracket draw still animate the difference
between two server renders, because an event carries no figures, only the news that
something changed.

## Transport

| Endpoint | Subscribes to | Used by |
|---|---|---|
| `GET /api/live/tournaments/:id` | one tournament's events | overview, bracket, standings, match, live board |
| `GET /api/live` | every tournament's events | home (a strip appears when any event goes live), dispute queue |

Both are public and carry only public identifiers. A draft tournament answers 404, as it
does everywhere. Neither endpoint reads a session.

A stream is `text/event-stream`. It opens with `retry: 3000` and a `: connected` comment,
then carries:

```
id: k7Qx2pLm-12
data: {"tournamentId":"trn_…","kind":"score","matchId":"mch_…","seq":12,"at":"2026-09-19T…"}

event: resync
id: k7Qx2pLm-12
data: {}

event: bye
data: {"reason":"ttl"}

: heartbeat
```

- An **event** (an unnamed `message`) says what changed: `score` (a scoreline recorded or
  the consensus moved), `match` (a match's status or its teams changed, including the winner
  placed in the next match), `standings` (a result became final) or `state` (the
  tournament's status changed). `seq` is monotonic within the channel's epoch; the `id` is
  `<epoch>-<seq>`.
- **`resync`** means the server could not resume from the id the client presented (another
  instance's epoch, an id the ring has evicted, a listener that reconnected): re-render once
  and carry on from the id it gives.
- **`bye`** means the server closed the stream on purpose (`ttl`: its lifetime is up;
  `shutdown`: the process is stopping): reconnect at once.
- A **heartbeat** comment goes out every `LIVE_HEARTBEAT_MS` (20 s) so a proxy keeps a quiet
  stream open.

Resumption: `Last-Event-ID` (the header a browser sends on its own reconnect) or
`?lastEventId=` (what the app's client sends, since it reconnects by hand to control the
backoff) replays the events after that id from a bounded in-memory ring (256 per channel).

## Channels and fan-out

Events are published with Postgres `NOTIFY` on two channels per event: `sideout_live:<tournament id>`
and `sideout_live` (everything). Each process's bus (`apps/sideout/src/server/live/bus.ts`)
holds a `LISTEN` on a channel while it has subscribers and for thirty seconds after the
last one leaves, and the bus is fed by notifications alone, the publishing process's own
included. That is what lets more than one instance serve the same event: every instance
sees the same notifications in the order Postgres delivered them. There is no broker, no
extra service and no new table; the listening connection is the one postgres.js dedicates to
`LISTEN` on the app's pool, reconnected with backoff on a drop (after which every stream on
that process is told to `resync`).

An event is published only after the transaction that made the change has committed
(`server/live/outbox.ts`): a writer calls `emitLive` next to its write, the function that
owns the transaction opens it with `liveTransaction`, and the queued events go out once it
has resolved. A rolled-back transaction publishes nothing. The emit sites are the consensus
writers (`server/consensus.ts`: every consensus and match move, the winner's advancement),
the forfeit (`server/matches.ts`), every tournament transition (`server/tournaments.ts`,
reached from the admin PATCH, the close and the Purse webhook) and the Purse push's
consensus moves (`server/purse/scores.ts`).

## Bounds

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_MAX_STREAMS` | `500` | Open streams one process serves; past it the route answers `429` with `Retry-After: 5` (`live_busy`). |
| `LIVE_MAX_STREAMS_PER_ADDRESS` | `8` | Open streams one client address may hold (`X-Forwarded-For` read with `TRUSTED_PROXY_HOPS`); past it, `429` (`live_too_many_streams`). |
| `LIVE_HEARTBEAT_MS` | `20000` | Heartbeat cadence, 5–25 s. |
| `LIVE_STREAM_TTL_SECONDS` | `900` | A stream is closed with `bye` after this long; the browser reconnects and resumes. |

A client that goes away releases its slot as soon as the server notices (the request's
abort, or a failed write). Every variable has a safe default; none is required.

## The client

`apps/sideout/src/components/motion/LiveRefresh.tsx` mounts on each live screen with a
`source` and drives `router.refresh()` from `components/motion/live-stream.ts`:

- one refresh per event or `resync`, coalesced so at most one is in flight (an event that
  arrives during a refresh queues exactly one more);
- the stream closes while the tab is hidden and, on return, one refresh catches up before a
  fresh stream opens;
- reconnection is by hand with exponential backoff (1 s doubling to 30 s, a quarter of
  jitter), carrying the last id; `bye` reconnects at once with up to a second of jitter;
- three short-lived failures in a row (a stream that lived thirty seconds before dropping
  does not count) switch the page to the D11 polling for a minute, then the stream is tried
  again; a browser with no `EventSource` polls from the start;
- while the stream is open the page sets `data-live="stream"` on `<html>`, and the design
  system's live dot (`.so-live-dot`) gains a faint halo. Polling keeps the plain dot. No
  layout changes.

The register screen's wait on a pending donation still polls (`LiveRefresh` without a
`source`); it is not a live-scoring surface.

## What a host needs

The response already carries `Cache-Control: no-cache, no-transform` (which also keeps
Next's compression from buffering it) and `X-Accel-Buffering: no`. A proxy in front of the
app must not buffer `text/event-stream` responses and must allow a request to stay open for
at least the heartbeat interval plus its own idle timeout; Railway's edge and nginx with
`proxy_buffering off` (or the `X-Accel-Buffering` header honoured) both do. With HTTP/1.1
between the proxy and the app, a stream holds one connection for up to
`LIVE_STREAM_TTL_SECONDS`; size the proxy's connection limit for `LIVE_MAX_STREAMS` per
instance. The service worker (`public/sw.js`) never intercepts `/api/live/*`.

## Verifying against a deployment

```sh
# 1. A stream opens and heartbeats (the id of any non-draft tournament works).
curl -N -sS https://<sideout>/api/live/tournaments/<trn_id> | head -c 400
# expect: "retry: 3000", ": connected", then ": heartbeat" within LIVE_HEARTBEAT_MS

# 2. An event arrives after a score is submitted. Keep 1 running, then on a signed-in
#    phone submit a scoreline on that tournament's match: a `data:` line with
#    "kind":"score" and the match id appears within a second.

# 3. Resumption. Take the last `id:` from 1, close it, submit another scoreline, then:
curl -N -sS -H 'Last-Event-ID: <that id>' https://<sideout>/api/live/tournaments/<trn_id> | head -c 400
# expect: the events after that id first (the ring replays them), no resync

# 4. Load shedding.
for i in $(seq 1 9); do curl -sS -o /dev/null -w '%{http_code}\n' -m 3 https://<sideout>/api/live & done; wait
# expect: the ninth from one address is 429 with Retry-After: 5 (LIVE_MAX_STREAMS_PER_ADDRESS=8)

# 5. In the browser: open a live match on two devices, submit on one; the other updates
#    without a reload and <html data-live="stream"> is set (the live dot has its halo).
#    Block /api/live/* at the proxy: within about ten seconds the page falls back to polling
#    (data-live="poll") and the figures still move.
```

The route tests are `apps/sideout/test/live/` (`stream.test.ts`: an event after a commit,
`Last-Event-ID`, heartbeat, `bye`, the caps, the 404; `outbox.test.ts`: the after-commit
ordering, the rollback, the ring), the client is `test/ui/live-refresh.test.tsx` (backoff,
the fallback, the coalescing, the visibility pause), and `e2e/live.spec.ts` is the two-page
Playwright flow.
