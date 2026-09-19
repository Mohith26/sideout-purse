# Signed score attestation

Stretch item 1 of the system spec (section 12): a phone signs the canonical scoreline it
submits with a WebCrypto key registered at team check-in, Sideout verifies the signature
before the consensus sees the submission, and Purse verifies it again against its own copy
of the key when the score arrives, so a score can be shown to have been submitted by a
registered device and not forged in transit, by the partner, or by anyone between the two.
Decision D5 (dual-team confirmation with organizer arbitration) is unchanged: attestation is
option C laid on top of option A. An unsigned scoreline is still accepted; a signed one
proves the phone it came from.

This document pins the contract. The code that implements it is one module shared by the
phone, Sideout's server and Purse, `packages/purse-types/src/attestation.ts`; the fixed
vectors in `packages/purse-types/test/attestation-vectors.ts` (copied verbatim to
`apps/purse/test/attestation/vectors.ts` and `apps/sideout/test/attestation/vectors.ts`)
fail the build if any byte of the form drifts.

## Keys

- **Algorithm.** ECDSA over P-256 with SHA-256 (`ES256`), the one Web Crypto pair every
  browser, worker and Node ship. Signatures are the raw `r || s` form Web Crypto produces
  (64 bytes), encoded base64url without padding (86 characters).
- **Where the private key lives.** The phone generates a non-extractable key pair
  (`crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])`)
  and stores the `CryptoKey` objects in IndexedDB (`sideout-device`, beside the score
  outbox). The private key is never exportable, never logged and never sent; nothing in
  either codebase can read it (`apps/sideout/src/lib/attestation/device.ts`). A browser
  that refuses IndexedDB keeps the pair for the session only.
- **What leaves the phone.** The public key as a JWK with exactly four members
  (`kty: "EC"`, `crv: "P-256"`, `x`, `y`), and signatures. Both servers parse the JWK
  strictly: a `d` member, a `kid`, or any other key type is refused.
- **The key id.** The RFC 7638 JWK thumbprint: base64url of SHA-256 over the canonical
  JSON `{"crv":"P-256","kty":"EC","x":"…","y":"…"}`. It is derived from the key by every
  party independently and never chosen, so a registration can never claim another key's id
  and the three copies (phone, Sideout, Purse) agree without trusting each other.

## Registration (check-in)

- **Sideout.** `POST /api/teams/:id/devices` with `{ publicKey }` from a signed-in member
  of the team, while the team holds a place (`registered` or `checked_in`) and the
  tournament is between `registration_open` and `live`. The row is `team_devices`
  (`dev_` ids): team, member, key id, public key, registration time; a revocation is the
  only update. One live row per key per team; a revoked key may be registered again as a
  new row (a found phone). Registering the same key twice returns the existing row. Every
  write audits (`device.registered`, `device.revoked`, `device.purse_mirrored`,
  `device.purse_mirror_failed`).
- **The mirror.** After Sideout's row commits, the key is registered with Purse for the
  member's linked user, `POST /v1/users/:id/devices` (secret-key auth, idempotent under
  `sideout:device:<dev id>:register`), and the Purse device id is recorded on the row. A
  member who has not linked a Purse account yet is mirrored when they link
  (`POST /api/me/purse/link`). A mirror that fails is audited and reported in the answer,
  never fatal to the check-in.
- **Purse.** `user_devices` (`udv_` ids), one live row per (user, key id); `GET
  /v1/users/:id/devices` lists them; `POST /v1/users/:id/devices/:deviceId/revoke` revokes.
  The runtime role holds `SELECT, INSERT` and column-level `UPDATE` on the revocation
  columns; a trigger refuses any other change and any un-revocation, for every role.
- **Revocation.** The organizer revokes from the event page of the console
  (`POST /api/admin/devices/:id/revoke`). The revocation is mirrored to Purse unless the
  same key is still live for the player on another team (Purse holds one registration per
  user and key). From then on every scoreline that phone signed is refused when it
  arrives, queued ones included.

## The canonical form

The bytes a phone signs, and both servers rebuild, are

```
"purse-score-attestation/1\n" + canonicalJson(payload)
```

as UTF-8, where `canonicalJson` writes JSON with object keys sorted by code unit, no
whitespace, strings as `JSON.stringify` writes them, and numbers as safe integers only (a
float, `undefined` or a bigint is refused, not coerced), and `payload` is

```json
{
  "v": 1,
  "keyId": "<JWK thumbprint of the signing key>",
  "timestamp": "<YYYY-MM-DDTHH:mm:ss.sssZ, the phone's clock at signing>",
  "sourceRef": "<the match id, mch_…>",
  "refs": { "teamId": "<the submitting team, tm_…>", "tournamentId": "<trn_…>" },
  "content": { "matchId": "<the same match id>", "sets": [[1, 21, 18], [2, 19, 21], [3, 15, 11]] }
}
```

- `content` is the consensus's own canonical scoreline: sets ordered by set number, always
  oriented from team A's side, each `[setNumber, teamAPoints, teamBPoints]`.
  `canonicalizeScoreline` (`apps/sideout/src/domain/scoreline-hash.ts`) now writes its
  string through the same `canonicalJson(scorelineContent(…))`, so the hash the two teams
  are compared on and the bytes a phone signs can never disagree about what a scoreline
  is.
- `sourceRef` is the value Sideout submits as the score's `sourceRef` to Purse (the match
  id), which is the one binding Purse can check on its own.
- `refs` are Sideout's further bindings. Purse records them verbatim and, when a
  participant row carries a `teamRef`, checks `teamId` against it.
- The domain prefix keeps a device key from being tricked into signing another protocol's
  JSON.
- At most 4096 bytes may be signed.

Written out, the pinned vector's bytes are

```
purse-score-attestation/1
{"content":{"matchId":"mch_0192f1a0-0000-7000-8000-000000000101","sets":[[1,21,18],[2,19,21],[3,15,11]]},"keyId":"8XbN5630JiGUaVkgMV6bdDTXYOUC485Hd2mumkzF1-o","refs":{"teamId":"tm_0192f1a0-0000-7000-8000-000000000011","tournamentId":"trn_0192f1a0-0000-7000-8000-000000000001"},"sourceRef":"mch_0192f1a0-0000-7000-8000-000000000101","timestamp":"2026-09-19T16:05:00.000Z","v":1}
```

A payload is never taken from the wire: the phone sends only `keyId`, `algorithm`,
`signature` and `timestamp` to Sideout, which rebuilds everything else from its own rows
(the tournament, the match, the team resolved from `team_members`, the canonical sets);
Sideout sends Purse the structured fields (`userId`, `keyId`, `algorithm`, `signature`,
`timestamp`, `refs`, `content`) and Purse rebuilds the payload with the score's own
`sourceRef`.

## Verification

**Sideout** (`apps/sideout/src/server/attestation.ts`, inside the score transaction after
the team is resolved and the scoreline judged legal, before the consensus):

1. `timestamp` is a real instant, at most 5 minutes ahead of the server's clock, and at
   most 72 hours behind it (a scoreline queued on a phone with no signal is replayed for up
   to three days; older than that it is refused and the phone says so).
2. The team has a live check-in under `keyId` (`unknown_device` otherwise; a revoked one
   is `device_revoked`).
3. The signature verifies over the rebuilt payload with that key (`signature_invalid`).

A refusal is `invalid_attestation` (HTTP 422) with one of those codes; nothing is stored. A
verified submission stores the public material (device, key id, signer, signature,
timestamp, refs, content, verification time) on `score_submissions.attestation`, never
updated, superseded with the row. The organizer's resolution of a dispute carries none.

**Purse** (`apps/purse/src/attestation/verify.ts`, inside the scores transaction under the
contest lock, before any row is written):

1. The score names a `sourceRef` and the attesting user is an entered participant.
2. `timestamp` is a real instant no more than 5 minutes in the future (age is the
   partner's rule).
3. When the attesting or the scored participant entered with a `teamRef`, it equals the
   signed `refs.teamId`.
4. Purse holds the key for the attesting user and it is not revoked.
5. The signature verifies over the rebuilt payload.

A failure of 1, 2, 3 or 5, or a revoked key, refuses the whole batch with the
`invalid_attestation` type (422), codes `attestation_source_required`,
`attestation_user_not_participant`, `attestation_timestamp_invalid`,
`attestation_timestamp_future`, `attestation_team_mismatch`,
`attestation_device_revoked`, `attestation_signature_invalid`. A key Purse does not hold
at all is recorded as `unverified` (see below).

## What Purse records

`contest_scores.attestation_state` is `none`, `verified` or `unverified`, fixed at insert,
and `contest_scores.attestation` holds the material verbatim plus the device it was checked
against and when. `ScoreResource` carries both (`attestationState`, `attestation`), so a
partner reading scores back, and the operator console's contest detail, see which scores a
registered device vouched for.

- `verified`: a device registered to the attesting user, unrevoked, signed exactly this
  content for exactly this `sourceRef`.
- `unverified`: an attestation was presented under a key Purse does not hold for that user
  (Sideout's mirror never reached Purse: the player linked their Purse account after the
  check-in and the mirror failed, say). The partner's own verification is all that vouches
  for it; the score is accepted as an unattested score would be and the console shows the
  gap. It is not a failure of proof, which is refused.
- `none`: the batch carried no attestation for that score.

## What travels with a score

When a match reaches `agreed`, `apps/sideout/src/server/purse/scores.ts` attaches to each
player's running score the verified attestation of their team's standing submission,
provided that submission's hash is the agreed hash and its signer has a linked Purse user
(the attestation is attributed to the signer's Purse user; a teammate's device vouches for
the whole team's score). A team that submitted unsigned, or whose reading the organizer
overrode, sends none. Purse verifies each again.

## What it proves, and what it does not

- A `verified` score was signed by a key that was registered, through an authenticated
  Sideout session, for the team and user it names, before the score was submitted; the
  signature binds the exact scoreline, the match, the team, the tournament and the moment,
  so it can be replayed onto nothing else. Neither Sideout nor Purse can produce one.
- It does not prove the scoreline is true: two honest phones can still disagree, and the
  consensus, the dispute queue and the organizer's arbitration stay the trust model
  (decision D5). The badge makes an unsigned reading visible during arbitration.
- Purse cannot recompute the running score (a count of match wins) from the scoreline; it
  verifies that a registered device signed this scoreline for this `sourceRef`, and records
  the scoreline. The mapping from scorelines to scores is Sideout's (docs/decisions.md,
  phase 7).
- A phone shared between two players signs as the phone, not the player: the check-in
  names the member who registered it.

## Where it shows

- **Match page**: a `Signed` / `Unsigned` badge on each standing reading and on the
  viewer's own, whether this phone is checked in for the viewer's team, and the score sheet
  says whether the scoreline it is about to send will be signed.
- **Dispute queue**: the same badge on both readings, so the organizer arbitrates knowing
  which side signed.
- **Register screen, step 3**: the check-in itself, and the team's checked-in phones.
- **Profile**: whether this phone is checked in for each current team.
- **Organizer's event page**: every checked-in phone with a revoke control.
- **Purse console, contest detail**: the attestation state of every score.

## Offline

The outbox (`apps/sideout/src/lib/offline/outbox.ts`) queues a signed scoreline with its
signature: nothing the wait changes is under the signature, so the replay is still valid
within the 72-hour window. A signature the server refuses when it arrives (the organizer
revoked the phone in the meantime, the window passed) is a definitive refusal like any
other 4xx: the item is kept as `failed` with the server's words for the player to read and
discard, never dropped silently, and never accepted unsigned in its place.

## Running it

`pnpm --filter @purse/types test` pins the canonical form and the vectors;
`pnpm --filter @purse/api test test/attestation` and `test/contract` drive Purse's registry
and intake (the contract fixtures record the device endpoints and the 422);
`pnpm --filter @sideout/web test test/api/attestation` drives Sideout's check-in, signing,
refusals, revocation and the push; `pnpm --filter @sideout/web e2e` (`e2e/attestation.spec.ts`,
the `mobile` project) runs the browser flow on the Boardwalk seed: check in, sign, the badge,
the dispute queue, the organizer's device list. `E2E_API_PORT` / `E2E_WEB_PORT` move the two
local servers when another run holds 4020/3010. The flow reads the match page back with a
reload after each submission: the in-place `router.refresh()` that follows a submission (and
`LiveRefresh`'s five-second poll) commits only some of the time on the match page, on `main`
as much as here (a poll's RSC fetch is often aborted by the router within milliseconds, and a
finished one is sometimes not applied); that is a phase 8 follow-up, not something this
feature changes.
