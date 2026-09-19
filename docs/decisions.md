# Decisions

The system spec ([`system-spec.md`](./system-spec.md), section 3) leaves twelve decisions
open and gives each a DEFAULT with a stated reason. Every one of them is taken at its
DEFAULT. The reason recorded next to each answer is the spec's own; where phase 0 had to
depart from a spec value for a stated reason, that is recorded separately below.

| # | Decision | Answer | Spec's reason |
|---|---|---|---|
| D1 | Repository layout | **A.** pnpm monorepo, two apps, shared packages, with the ESLint boundary rule forbidding Sideout from importing anything from Purse except `@purse/sdk` and `@purse/types`. | You get the demo velocity and the boundary is still enforced, just by tooling rather than physics. |
| D2 | Boundary enforcement | **B.** One Postgres instance, two logical databases, two distinct connection strings that are never both loaded into the same process. | Cheaper to host, still isolated. One schema with two namespaces (C) is wrong because a single transaction could span both and the platform claim collapses. |
| D3 | Currency and legal posture | **A, treated as MUST.** Closed-loop only: `POINTS` for free entry, `CREDIT` funded by sponsors and redeemable for goods. Charity donations are separate real dollars via Stripe that never touch contest escrow. No cash out. | Everything downstream assumes it. The ledger, escrow model and settlement math are identical to a real-money system, so nothing about the engineering is diminished; you just cannot be wrong in a way that matters legally. Swapping the asset type to real currency is a licensing problem, not an architecture problem. |
| D4 | Ledger representation | **A, treated as MUST.** Immutable double-entry journal: balanced debit and credit lines, balances derived by aggregation, corrections by reversing entry. | This is the single most impressive component in the build and the one an engineer will check first. A balance column with a log (B) is impossible to prove correct; drift is undetectable. |
| D5 | Score trust model | **A.** Dual-team confirmation with organizer arbitration: both teams submit independently, agreement by hash, mismatch goes to a dispute queue. | It is the honest model for a self-reported sport, it produces a real state machine, and it is the thing to talk about in an interview. Signed attestation (C) is a stretch goal. |
| D6 | Settlement trigger | **C, defaulting to A.** Both operator close and auto-settle are built and selectable per contest through a `settlement_policy` column; every Sideout tournament ships on `operator_close`. | Build both paths because the difference is interesting and testable, but ship every Sideout tournament on operator close. |
| D7 | SDK delivery | **A.** Cross-origin iframe plus typed postMessage, wrapped by a thin `@purse/sdk` that manages the iframe, the handshake and the message types. REST-only (C) is supported as a headless mode for reads. | This is what real platforms do, because it keeps the partner's DOM away from credentials and session. |
| D8 | Identity ownership | **A for the wallet-bearing identity, B for the app session.** Purse owns the wallet identity; Sideout authenticates its own users however it likes and links each to a Purse user via `external_id`. | Two identities, one link table, which is exactly the real-world shape. |
| D9 | Eligibility rules representation | **A.** Declarative JSON ruleset, versioned, evaluated by a pure function; the ruleset version is stored on every persisted decision. | A versioned ruleset means you can show an auditor which rules were in force when a decision was made, and you can unit-test the evaluator against a table of cases. |
| D10 | Prize structure representation | **A.** Declarative structure (winner-take-all, placement table, percentage split, guaranteed minimum) compiled to payouts by a pure function. | This is where the property tests live and where the rounding rule earns its keep. |
| D11 | Real-time transport | **B for v1, A in polish.** Polling at 5 seconds now; Server-Sent Events as a contained upgrade in the polish phase. | Polling at 5s is invisible to a demo audience and removes a class of deployment problems. SSE is a contained upgrade later. |
| D12 | Hosting | **Railway.** Two services, one managed Postgres with two logical databases, custom subdomains on a personal domain. Hosting specifics are deferred to phase 9. | Railway is the DEFAULT because the append-only database-role enforcement from 4.2.2 is fiddlier on Workers plus Hyperdrive, and the ledger is the last place to accept friction. Keep this entirely off any employer infrastructure. |

## Phase 0 departures from spec values

The spec allows a DEFAULT to be overridden when a stated reason demands it. One token
value needed that.

### `--text-tertiary` lightened from `#646C79` to `#7D8591`

Section 6.4 and acceptance criterion 24 require WCAG AA contrast across all text tiers.
The spec's `--text-tertiary: #646C79` measures **3.3:1** on `--bg-overlay` and **3.8:1**
on `--bg-base`, below the 4.5:1 AA threshold for normal text on every background tier.
`#7D8591` keeps the same cool neutral hue and lands at 4.7:1 on `--bg-overlay`, the
lightest surface, and 5.4:1 on `--bg-base`, so every tier passes on every surface. The
contrast unit test in `@sideout/ui` asserts this for every text tier on every background
tier and would fail against the original value.

## Phase 1 decisions

### Two Purse database roles: `purse_migrator` owns, `purse_app` runs

Spec 4.2.2 rule 5 requires `UPDATE` and `DELETE` on the journal tables to be revoked from
the application role "at the database level so this is not merely a convention". Phase 0
had one Purse role, `purse_app`, which owned the databases. In Postgres an owner holds
every privilege on what it owns and can re-grant anything that was revoked, so a `REVOKE`
against an owner is exactly the convention the spec rules out: it documents an intent
without enforcing it.

Phase 1 therefore splits the role. `purse_migrator` owns the `purse` and `purse_test`
databases and every object in them and is used only by `pnpm db:migrate`, `pnpm db:seed`,
`pnpm db:setup` and the test reset. `purse_app` is the API's runtime role: it owns nothing,
holds no grant option, and receives exactly the privileges the runtime needs from the
custom migration `apps/purse/drizzle/0002_ledger_roles.sql`, which runs as the owner. On
`journal_entries`, `journal_lines` and `audit_log` that is `SELECT` and `INSERT` only. A
non-owner's `GRANT` is a no-op in Postgres and `ALTER TABLE ... OWNER TO` is refused, so
the runtime cannot widen its own privileges; `test/ledger/roles.test.ts` proves all of
this, including that the same `UPDATE` and `DELETE` statements succeed as the owner, so
it is the role and not the SQL that is refused. The API also checks at boot that the role
it connected as cannot rewrite the journal and refuses to serve otherwise.

Sideout keeps one role. It has no append-only requirement, and a second role there would
be ceremony without a guarantee behind it.

### The audit log is append-only from day one

`audit_log` (spec 4.1) lands in phase 1 with one writer, `account.opened`; phase 2's
contest `transition()` is its next. It is held to the journal's rule from the start:
`purse_app` holds `SELECT` and `INSERT` on it and nothing else, the boot-time role check
covers it, and `test/ledger/roles.test.ts` expects its `UPDATE`, `DELETE` and `TRUNCATE`
to fail. A record of who changed what is worth nothing if the runtime can edit it.

### Column-level UPDATE on `accounts` and `tenants`

A derived balance depends on an account's `kind`, `normal_side`, `tenant_id`, `owner_ref`
and `asset`. A runtime that could rewrite those could flip a wallet's sign or move it to
another tenant without touching the journal, and `reconcile()` would stay clean. The only
runtime update is to `status` (freezing or closing), so `purse_app` holds `UPDATE` on
`status` and `updated_at` only, on both `accounts` and `tenants`
(`apps/purse/drizzle/0004_ledger_guards.sql`). Postgres checks `FOR UPDATE` row locks
against column privileges, so `postEntry`'s account locks are unaffected.

### The database checks every entry at commit

Spec 4.2.2 rule 2 says an entry's balance is "checked in the same transaction that inserts
the lines, before commit". `postEntry` checks rules 1 to 4 before it opens a transaction,
which is the same thing for every caller of `postEntry`, but says nothing about a writer
that bypasses it. A deferred constraint trigger on `journal_lines`
(`journal_lines_entry_balanced`, initially deferred, so it runs at commit and sees every
line of the transaction) verifies that each entry touched has at least two lines, one
asset, and debits equal to credits, whoever is writing and however many statements they
used. The service keeps its own checks for their error codes; the trigger is the floor.
Only the owner can disable it, which the reconcile tests do for one transaction at a time
to inject the corruption `reconcile()` exists to find.

### Idempotency keys are unique per tenant

Spec 4.2.2 reads `idempotency_key (unique, not null)`. The unique index is on
(`tenant_id`, `idempotency_key`) rather than on the key alone, and `postEntry` looks a
key up within the caller's tenant. Tenancy is real from day one, and partner-chosen keys
(`Idempotency-Key` headers, phase 3) would otherwise collide across partners: the second
partner to use a key would be refused a legitimate operation and handed the first
partner's entry id in the conflict detail. Within a tenant the rule is the spec's: the
same key with the same payload returns the original entry, a different payload is a
conflict, and no other tenant's use of the key is visible. `reverseEntry` and `voidEscrow`
take the acting tenant for the same reason and refuse another tenant's entry with
`entry_wrong_tenant` at the ledger boundary, not in each caller.

### The last reconcile result is not on `/health` yet

Spec section 10 lists "last reconcile result" among what `GET /health` reports. It
arrives in phase 9 with the scheduled reconcile job and a persisted record of each run;
until then there is nothing durable to report (an in-process memory of the last
`GET /internal/reconcile` call would read `null` after every restart and differ per
replica), so the field is absent rather than misleading. `/health` reports sha, migration
state, ruleset version and SDK version, as spec 4.7 lists.

### Journal timestamps at millisecond precision

`posted_at` and `created_at` on `journal_entries` are `timestamptz(3)`. A JavaScript
`Date` carries milliseconds; at Postgres's default microsecond precision an entry's
`posted_at` read back and passed to `balanceOf(asOf)` would fall a fraction of a
millisecond before the entry itself and exclude it. At millisecond precision the value
round-trips exactly, so "the balance as of this entry" means what it says. `posted_at` is
`clock_timestamp()` taken after every lock is held, so for any one account it follows
commit order; `created_at` keeps the transaction start.

### `contest_escrow` may not go negative either

Spec I3 protects `user_wallet`. `postEntry` applies the same write-time guard to
`contest_escrow`: funds held for a contest cannot be less than nothing, and refusing it in
the ledger means phase 2 cannot refund or settle more than was escrowed by construction.
The debit-normal source accounts and the liability accounts run negative by design
(issuing points debits `promo_liability`).

## Phase 0 implementation choices worth knowing

These are not spec decisions; they are the answers phase 0 gave to questions the spec
leaves to the builder, recorded so later phases do not relitigate them.

- **Tailwind 4, CSS-first.** The `@sideout/ui` "Tailwind preset" is a CSS `@theme` block
  mapping every token to a Tailwind utility with the token's own name (`bg-bg-raised`,
  `text-text-secondary`, `border-border-subtle`, `rounded-card`, `text-body`,
  `ease-out-expo`; durations have no theme namespace and are used as `duration-(--d-base)`).
  Tailwind 4 has no JavaScript preset; the CSS theme is the equivalent and the same file
  works in any consumer, including the Purse embed app and operator console in phases 4
  and 5.
- **Primitives are plain CSS, not Tailwind classes.** `AppShell` is styled from the token
  custom properties in `@sideout/ui/styles.css`, so a consumer never has to configure
  Tailwind content scanning of the package for the primitives to render.
- **"Archivo Expanded" is the Archivo variable font at width 125.** Google Fonts ships
  Archivo with a `wdth` axis (62–125); there is no separate Expanded family. Display text
  sets `font-stretch: 125%`.
- **One `.env` per app, never one at the root.** D2 says the two connection strings are
  never loaded into one process. `apps/purse/.env` holds `PURSE_DATABASE_URL`;
  `apps/sideout/.env` holds `SIDEOUT_DATABASE_URL`. `pnpm db:migrate` at the root runs each
  app's migrator as a separate process for the same reason.
- **Ids are UUID v7 with a typed prefix and a CHECK constraint.** `tnt_`, `usr_`, `chr_`
  and the rest live in one registry in `@repo/ids`; each table checks its own prefix at
  the database level.
- **Seed data never lives in migration history.** Migrations are forward-only and describe
  the schema; rows the platform cannot run without are upserted by `pnpm db:seed`
  (`apps/purse/scripts/seed.ts`), which is idempotent and safe on every deploy. The Sideout
  tenant is keyed on its unique name and created with the stable id `SIDEOUT_TENANT_ID`
  from `apps/purse/src/db/seed.ts`, so every environment agrees on it.

## Phase 2 decisions

### "All expected results present"

Spec 4.3 defines `awaiting_settlement` as "all expected results present" without defining
"expected". Phase 2 defines it as: **every participant in state `entered` has a counting
score (the one not superseded) whose `attempt_finished` is true.** Withdrawn participants
hold no stake and are not expected to score; disqualified participants are not expected to
score either (they are placed last, unscored, at settlement, whatever was submitted for
them, so a disqualification cannot be undone by a score). The check runs inside
`submitScores`, under the contest row lock, after every batch: when it first holds, the
platform (system actor) moves `in_progress` to `awaiting_settlement` and, for
`settlement_policy = auto`, settles in the same transaction. An operator may also move a
contest to `awaiting_settlement` explicitly with attempts still unfinished (a no-show that
will never score), which is why the check is a trigger for the automatic path and not a
precondition of the state.

### A finished attempt is final

Spec 4.1 makes `contest_scores` append-only with a `superseded_by` chain but does not say
when a new score may supersede an old one. Phase 2's rule: a new submission for a user
supersedes their counting score **unless that score has `attempt_finished = true`, in which
case the whole batch is refused** (`attempt_already_finished`). This mirrors the overwrite
rule the product relies on: Sideout pushes a score only once its consensus machine reaches
`agreed`, and an agreed result is not silently replaced by a later push. An unfinished
attempt (a live, in-progress score) may be superseded as often as needed. The database
holds the rule too: `contest_scores_supersede_once` refuses to supersede a finished
attempt, to supersede a row twice, to un-supersede, or to change anything but
`superseded_by`, for every role.

### Scores are accepted in `awaiting_settlement` as well as `in_progress`

Spec 4.3 says `in_progress` is where "scores being accepted"; phase 2 also accepts them
in `awaiting_settlement`. The preview hash (spec 4.7) exists to freeze a close against
inputs that change between the preview and the close; if nothing could change once a
contest was awaiting settlement, the hash would be ceremonial. The realistic case is an
operator who moved a contest on with an attempt unfinished and then receives that
player's finishing score: it must be able to land, and a close computed before it must be
refused. `test/contests/concurrency.test.ts` fires exactly that race. Nothing is accepted
once a contest is `settling`, `settled`, `cancelled` or `voided`, and nothing before
`in_progress`. Confirmed at review, including its consequence: on an `auto` contest an
operator moved on early, a late finishing score settles the contest with no hash to check.

### The payout hash canonical form

`payoutHash(payouts)` (`apps/purse/src/settlement/hash.ts`) is SHA-256, lowercase hex, over
the string `{"v":1,"payouts":[...]}` with no whitespace, where the array holds one
`[placement, userId, payout]` triple per entrant, sorted by placement then `userId`, and
`payout` is a decimal string. The version field lets a later change to the form be told
apart from a stale preview. The preview returns it, the close requires it, and a close
whose recomputation differs is refused with `preview_hash_mismatch` before anything moves.
A replay of a close under its idempotency key presents the same hash, so it is a replay;
the same key with a different hash is a different request and a conflict.

### The rounding rule, and what a structure means

Spec 4.4 rule 3 is implemented exactly as written (`apps/purse/src/settlement/settle.ts`,
`apps/purse/src/settlement/README.md`): floor division, then the remainder one unit at a
time to the best placement first, then the next; within a tie group by ascending `userId`.
"Descending placement order" is read as best first, which is what makes 100 three ways
34/33/33. Phase 2 also fixes what the spec leaves open about the structures themselves:

- **Every structure is a weight vector over placements, truncated to the scored
  placements.** A `placement_table` of explicit amounts pays exactly its amounts when the
  pool equals their total and shares the pool in the same proportions otherwise; a table
  whose amounts exceed the pool cannot pay more than the pool holds, and one whose amounts
  fall short must not leave value in escrow (conservation is a MUST). Weights beyond the
  last scored placement are not used, so a `[50, 30, 20]` split over two scored entrants
  pays them 5/8 and 3/8.
- **Percentages are whole percents summing to 100, non-increasing by placement.** A
  non-increasing vector is what makes placement monotonicity (spec 4.4, "a strictly higher
  score never receives strictly less") provable rather than incidental; a structure that
  needs finer shares uses amounts.
- **A contest in which nobody scored splits the pool evenly.** Nobody can be ranked, so
  nobody can be paid by rank; voiding is the operator's alternative, but the engine
  defines an outcome rather than throwing on a valid contest.
- **`guaranteed_minimum` honours floors best placement first when the pool cannot cover
  them all**, then shares the remainder by percentage when it can.
- **`participationFloor`** is an optional field on every structure: a per-entrant amount
  paid to everyone, scored or not, before the placements (spec 4.4 rule 5's "participation
  floor"). A pool that cannot cover it is split evenly.
- **Tie-break keys**: `higher_seed_wins` prefers the lower seed number (seed 1 is the top
  seed; unseeded entrants lose to seeded ones), `earliest_submission_wins` prefers the
  earlier counting score; a tie the rule cannot separate is shared like `split_evenly`.
  Seeds are set at entry (`contest_participants.seed`), which is the one column added
  beyond spec 4.1's list, along with `contests.tie_break`, because the engine's signature
  in 4.4 takes a `tieBreak` that has to be stored somewhere.

### `voided` is reachable from `open`

The spec 4.3 diagram draws `voided` from `locked`, `in_progress` and `awaiting_settlement`.
Phase 2 allows it from `open` too. An open contest with entries has no other honest exit:
`cancelled` is for a contest holding nothing, and locking a contest only to void it is
ceremony that changes no money. `cancelled` remains reachable from every non-terminal
state but `settling` and refuses a contest holding any entry. Confirmed at review.

### A withdrawn entrant may re-enter while the contest is open

Spec 4.1 gives `contest_participants` one row per user per contest and 4.2.5 refunds a
withdrawal before lock; neither says whether the user may come back. Phase 2's rule: **yes,
while the contest is `open` and before `locks_at`, under the same conditions as a first
entry** (capacity, eligibility, funds). `enterContest` reactivates the withdrawn row rather
than inserting a second one: the state returns to `entered` and `entry_journal_entry_id`
is pointed at a fresh escrow entry keyed by the new request, so the row always names the
entry that currently holds the stake, which is what I7 checks and what a void reverses.
The re-entry carries the new request's `team_ref` and `seed`: a player who withdrew because
a partner dropped out comes back with another, and a re-seeding at that point is the
tenant's call. Those two columns change on that move and on no other; there is no
separate "edit my entry" operation. The database admits exactly this and nothing more:
`purse_app` may update `state`, `entry_journal_entry_id`, `team_ref`, `seed` and
`updated_at`, and the `contest_participants_guard` trigger lets the entry link change only
on `withdrawn -> entered` (and requires it to change then) and lets `team_ref` and `seed`
change only on that same move, for every role. The audit row for a re-entry is
`contest.entry.reentered`, with the withdrawn row as `before`.

The lock time is the same for leaving as for joining: `withdrawEntry` refuses once
`locks_at` has passed (`invalid_contest_state`), whether or not the operator has issued
the `locked` transition, so no stake can leave escrow after the moment entries close.

### Entry amounts are strictly positive

`contests.entry_amount > 0` at the database. Every entry escrows something, so every
participant has an escrow entry to link to and I7 holds for every row; a free contest is
a contest whose entry fee is paid in promo points the platform issued, which is exactly the
`POINTS` model. Sponsor-funded prize pools with no entry fee are a later phase's addition
to the ledger, not a zero here.

### Service-level idempotency: the `idempotency_keys` record

Spec section 2 rule 4 says every mutation is idempotent. The journal already replays an
entry by key; the contest mutations may create several rows or, on an empty contest, no
entry at all, so they need their own record. Phase 2 lands spec 4.1's `idempotency_keys`
table keyed on (`tenant_id`, `key`) with the operation, a hash of the request and a small
JSON record of the ids the operation produced; a replay reloads the original result from
those ids rather than storing a response body, so the replay is exact and typed and the
table is append-only for the runtime. Partner keys are per tenant, as the ledger's
already are. (Phase 3 has since added the HTTP layer's response columns to this table
under a `scope` column and the 30-day purge as `db:purge`; see "Two layers of
idempotency, one table".) Request keys are at most 200 characters so the ledger keys
derived from them (`contest-entry:<key>`, `contest-withdraw:<key>`) fit the journal's 255.

### Money moved by settlement and void is keyed by the contest, not the request

A contest settles once and is voided once, so the settle entry's idempotency key is
`contest:<id>:settle` and each void reversal's is `contest:<id>:void:<participant>`. The
auto-settle path has no request key to derive from, and a contest-scoped key means a
second attempt by any route finds the entry rather than posting another. Entries and
withdrawals, which happen many times per contest, derive their ledger key from the
request's key.

### The phase 3 hooks left in place

(Phase 3 has since replaced the hook and mounted the routes; see "Phase 3 decisions".)

`apps/purse/src/contests/eligibility.ts` is the one named hook `enterContest` calls; it
always allows and is marked as phase 3's to replace. `contest_not_open`, `contest_full`
and `insufficient_balance` (as the ledger's `insufficient_funds`) are already enforced at
entry without it. `contest_participants.user_id` is a typed id with no foreign key until
`users` exists; the seed's six users have stable ids so phase 3 can give them rows. The
public routes, `GET /contests/:id/preview` included, are phase 3's and mount on
`previewSettlement` and `closeContest`, which already exercise the preview-hash mechanism
end to end at the service level; phase 2 adds no HTTP surface for it.

## Phase 3 decisions

### The operator scope is a flag on a secret key, not a third key kind

Spec 4.1 seals `api_keys.kind` as `secret | publishable` and spec 4.7 marks
`POST /users/:id/credits` "operator scope only". Phase 3 keeps the two kinds and adds
`scopes text[]` to `api_keys`, whose only value today is `operator`; a publishable key may
carry none (a CHECK holds both). A request on an operator-scoped key acts as an
`operator` actor (`audit_log.actor_kind = 'operator'`, `actor_ref` = the key id), which is
also what lets it close an `operator_close` contest (spec 4.3 MUST) and drive `finish`
and `void`; a plain secret key acts as the `tenant` and is refused those with
`permission_error` (`operator_scope_required` for credits, `operator_required` for a
close). This mirrors how real platforms model restricted keys and keeps the console's
"create, reveal once, revoke" flow (phase 5) on one table. The seed's Sideout secret key
carries the scope, because Sideout's server is the operator of its own tournaments.

### Key format and lookup

A key is `sk_` or `pk_`, the environment, and 32 characters from `[A-Za-z0-9]`
(`sk_sandbox_...`), so the environment is visible in the prefix a console shows and a log
redacts. `key_prefix` is the type, the environment and the first eight random characters,
indexed; authentication finds the candidates by prefix and verifies the argon2id hash
(OWASP's 19 MiB / 2 iterations / 1 lane) of the presented key, so a prefix alone opens
nothing and the database holds only hashes (a CHECK refuses anything but an
`$argon2id$` string). Verified plaintexts are remembered in process by their SHA-256 for
five minutes so a hot key is not re-hashed per request, and `last_used_at` is written at
most once a minute per key. Sandbox and live keys are tags in v1: the two environments
share one database and the tag is carried on the actor and in the logs; partitioning data
by environment is a phase 9 hosting concern.

### Embed tokens are stored as SHA-256, not argon2

An embed token is 32 random bytes (`embt_` plus base64url): a high-entropy secret that no
one types, so a plain digest is the right hash and argon2's cost buys nothing. It is
single-use, scoped to one user and one flow, and expires in five minutes (spec 4.8 rule
5); consuming it is one `UPDATE ... WHERE consumed_at IS NULL`, so two frames racing for
one token cannot both win, and a trigger refuses un-consuming for every role.
`POST /users/:id/verification` mints the identity flow's token; `POST /embed/tokens` mints
any flow's. Consumed and expired tokens are kept a day for support and then purged. The
plaintext is returned once and rests nowhere: the v1 idempotency layer stores those two
responses with `token: null` and `replayed: true` in place of the token (`okOnce`), so a
replay under the same key returns everything else unchanged and a partner that lost the
token mints another under a fresh key.

### Two layers of idempotency, one table

Phase 2's `idempotency_keys` rows are the service layer's (the ids an operation produced,
committed with its effects). Phase 3 adds the HTTP layer the spec describes (endpoint,
request hash, response status and body) to the same table under a `scope` column that is
part of the primary key, so a partner's key is recorded twice, once per layer, and the
two never collide. The v1 middleware holds no transaction across a request: it claims the
key in `idempotency_reservations` (one row per key, expiring after a minute), runs the
handler against the pool, and then stores the `http` row. Every service commits its own
transaction, so the identity provider is called with no row lock and no pool connection
held, and a refused entry's decision record commits with the 403 that reported it. A
concurrent request under a live claim waits for the stored response (up to five seconds,
then `conflict` / `idempotency_key_in_progress` with `Retry-After`); a crash between the
claim and the store leaves a claim that expires, after which the key may be retried. A
2xx and every 4xx but 429 are stored, because a refusal is the answer to that request
(Stripe's rule); a 5xx and a 429 store nothing and release the claim, so the partner
retries the same key and the request is performed then. The stored body is jsonb, so a
replay is the original response as JSON (key order may differ). Keys are remembered for
at least 30 days; `pnpm --filter @purse/api db:purge` removes older rows and their claims as
the owner, after which a key is fresh.

### A refusal for funds alone is `insufficient_funds`

Spec 4.5 lists `insufficient_balance` among the eligibility reasons and spec 4.7 lists
`insufficient_funds` among the error types. The evaluator reports the shortfall as a
reason (with `add_funds` as the action) and records it like every decision; the entry
route reports a decision whose only reason is the shortfall as `insufficient_funds` (402,
the money type a partner routes to funding), and any other refusal, including a shortfall
alongside a compliance reason, as `not_eligible` (403). Both carry `reasons[]`,
`requiredAction` and `rulesetVersion` in `detail`. A contest that is not open or is full
is refused before the evaluator runs, as `not_eligible` with `contest_not_open` or
`contest_full` as its one reason and the version the contest is judged under, and writes
no decision row. The ledger's own non-negative wallet guard stands behind the evaluator for
the race it cannot see.

### An entry amount no one could stake is refused at creation and at open

The per-contest stake limit is a rule about the contest, not the entrant: a contest whose
`entryAmount` is above the `perContest` limit of the ruleset its entries are judged under
would refuse every entrant `stake_limit_exceeded`. `createContest` refuses it against the
active ruleset (the one it is about to pin) and `open` refuses it against the pinned one
(a draft may have been edited, or the pin may predate the limit), both as
`invalid_request` / `entry_amount_above_stake_limit`. The evaluator keeps its own check
for a contest opened before this rule, or one with no pin whose active fallback changed
after it opened.

### Velocity is gross, per asset, from the journal

Rolling 24-hour and 7-day totals (spec 4.6) are the sum of every `escrow` entry's debit
of the user's wallet in the contest's asset, bounded on `posted_at`. A stake that was
later refunded still counted as staked at the time (enter-and-withdraw does not reset a
limit), and the limits in the ruleset apply per asset in that asset's minor units. The
decision includes the entry being attempted, and `enterContest` takes a per-user advisory
lock after the contest lock so two simultaneous entries by one user to different contests
see each other's stake. Every decision, allowed or refused, is one `eligibility_decisions`
row carrying the ruleset version and the evaluator's input as it stood; a refusal's row is
written after the entry's transaction has rolled back, so the refusal is recorded and
nothing else is.

### Which ruleset judges an entry

A contest pins the active ruleset version at creation (spec 4.1
`eligibility_ruleset_version`), and every entry to it is judged under that version; a
contest from before any ruleset existed falls back to the active one. Rulesets are global
(not per tenant), a version's body never changes once stored (a trigger holds it), and
exactly one version is active (a partial unique index holds it). The spec's example is
seeded as `2026.09.1` with phase 3's one addition, `collusion` (`minMeetings`,
`oneSidedShare`), optional with defaults so the spec's JSON validates unchanged.

### The evaluator's input carries `asOf`

Spec 4.5's `evaluate` input has no clock, but a pure function must be told the instant
to judge an age and a restriction's window against. `asOf` (ISO 8601) is the one field
added to the input shape. Two readings the spec leaves open are fixed with it: an age is
checked whenever the date of birth is known, for any asset; an unknown date of birth is
refused only where identity is required (`identity_unverified` with
`provide_demographics`), since verification is what establishes it, so a free-to-play
entry with no demographics is allowed, which is the asymmetry the spec asks for. All
applicable reasons are reported in a fixed priority order and the first one's action is the
decision's, so a terminal reason (a block, a self-exclusion, a rejected identity, an
under-age user) never comes with "add funds". The stake and velocity limits rank above the
shortfall for the same reason: no amount of funds admits an entry above the per-contest
limit, and only time clears a velocity overrun, so a user refused for both is told nothing
rather than "add funds".

### `rejected` is terminal for the user

The verification machine is `unstarted -> pending -> verified | rejected`, with
`verified -> pending` once `reverify_after` has passed (365 days after verification unless
the provider says otherwise). Spec 5.3 shows a refusal as a plain terminal explanation
with a support path and no retry button, so a rejected user cannot start again through the
API (`invalid_state` / `verification_rejected`); the database admits `rejected ->
unstarted` for the operator reset phase 5 builds. `pending` may be started again (a fresh
embed token for an abandoned iframe). The provider is called between two short
transactions, never under the row lock, and its answer is applied only if the user is still
`pending` when it arrives. The geo seam is held to the same rule: `upsertUser` and
`enterContest` ask it before their transactions open.

### Risk signals are surfaced, never enforced

The `RiskProvider` seam is consulted at entry alongside the evaluator. Its dev
implementation applies the spec 4.6 velocity and duplicate-account rules as signals
(`velocity_near_24h_limit`, `duplicate_identity_open`, `new_account_max_stake`, ...) and
answers `review`, never `deny`; a `review` becomes an `operator_flags` row (`risk_review`)
and the entry goes through. The evaluator enforces the limits themselves. Duplicate
identities (SHA-256 of the normalised name and the date of birth) are flagged per pair
within a tenant, once, and never auto-block; a user missing either part gets a fingerprint
of their own id so a cleared field cannot leave a stale match behind, and two users
written at once with one identity serialise on the fingerprint so the pair is still
flagged. The head-to-head collusion signal is checked inside every head-to-head
settlement for the pair it involved, and nowhere else; a meeting is a settled head-to-head
contest with a strict winner, and a qualifying pair is flagged once. A restriction's
`reason` reaches the partner only when the user placed the restriction on themself
(`created_by` is `user:<id>`, whatever the kind); an operator's or the platform's reason
stays in Purse. A `location` sent with an entry is recorded before the entry is attempted,
so it stands whether or not the entry is refused.

### Routes beyond the 4.7 list

Spec 4.7 lists `open` and `lock`; `start` (`in_progress`) and `finish`
(`awaiting_settlement`) are mounted the same way, because scores are accepted only from
`in_progress` and a contest whose results never all arrive must still reach settlement
over HTTP. `cancelled` has no route: nothing in the flow needs it, and a partner can
leave a draft alone. `GET /health` and `GET /internal/reconcile` answer at the root
(phase 0) and under `/v1` (the spec's base); neither takes an API key.

### The phase 3 backfill and `accounts.user_id`

`contest_participants.user_id`, `contest_scores.user_id` and `contest_results.user_id` are
foreign keys to `users`; `accounts.owner_ref` cannot be a conditional one, so a wallet
names its owner twice, `owner_ref` for the natural key and `user_id` for the foreign key,
and a CHECK holds them equal (null for every other kind). A database migrated from phase
2 holds wallets and entries for users that had no row: migration 0007 gives each a
placeholder user (`external_id = 'legacy:<id>'`) so the keys can be added valid, and the
seed completes the six seed users by their stable ids, which the `users_guard` trigger
allows only for a `legacy:` placeholder. A fresh database backfills nothing.

### Rate limits and the last reconcile result

The token buckets live in process memory (`RATE_LIMIT_BURST`, `RATE_LIMIT_PER_SECOND`,
at most ten thousand buckets). An authenticated request spends from its key's bucket,
keyed by the key's id, so nobody who merely knows a partner's visible prefix can spend
the partner's allowance; a request that fails authentication spends from its address's
bucket, and once that is empty a failure is answered 429 instead of 401. A request that
authenticates is never refused on its address: behind a proxy every partner shares one,
and a stream of bad keys must not lock the partners out. Once an address's bucket is
empty, a key whose prefix no key has (or no key at all) is refused before authentication
at the cost of one index lookup; a key whose prefix exists is still verified, so a guess
that copies a real prefix costs one argon2 check per request however many it sends. The
hosted edge rate limit is the phase 9 backstop for that. The address is the socket's
unless `TRUSTED_PROXY_HOPS` says how many proxies append to `X-Forwarded-For`, in which
case it is the entry that many from the header's right (the hosted deploy, behind one
load balancer, sets it to 1; a bare process leaves it 0 so a client cannot choose its own
bucket). A shared store for several replicas is a phase 9 hosting concern. `/health` now
reports the active ruleset version; the last reconcile result still waits for phase 9's
scheduled job. `apps/purse/.env.example` lags `src/env.ts` for the phase 3 variables
because writes to env templates are denied by policy in the automated pipeline;
`src/env.ts` and `docs/providers.md` are the canonical variable list.

## Phase 4 decisions (SDK, embed, webhooks)

### The embed app is a static export the API serves under `/embed`

Spec 4.8 rule 1 puts the frame on the Purse origin. `apps/purse-embed` is a Next.js app
whose `next build` is a static export (`output: 'export'`, `basePath: '/embed'`); the API
serves that directory under `/embed` (`src/routes/embed-static.ts`, `PURSE_EMBED_DIR` or the
sibling app's `out` by default), so in every environment the frame is `purse.<domain>/embed/`
and its calls to `/v1/embed/*` are same-origin: no CORS between the frame and the API, one
cookie jar, one deploy (the spec's hosting table already puts "Purse API + embed" on one
service). A separate subdomain would have needed cross-origin cookies between the frame and
its own API on top of the ones the partner page already forces. Locally, `pnpm dev` runs
`next dev` on :4100 with `/v1` proxied to :4000 for hot reload (point the SDK at
`purseOrigin: 'http://localhost:4100'`), and a `pnpm --filter @purse/embed build` makes the
API on :4000 serve the export like production does. An API process with no build answers
`/embed/*` 404 with a hint, never an empty page. Every embed response carries
`Content-Security-Policy: frame-ancestors` naming the union of every tenant's active origins,
so a page that is not a partner's cannot even frame the flow.

### The origin allowlist is a `tenant_origins` table

Rule 3's allowlist is per tenant and read three times: by the frame (which refuses to say a
word to a `parent` that is not listed), by `POST /v1/embed/session` (which refuses to redeem a
token for one), and by the API's CORS layer (which names an origin in
`Access-Control-Allow-Origin` only if the presented key's tenant lists it; the preflight, which
carries no key, only if some tenant does). An origin is a scheme, host and optional port,
lower case, nothing else; a revoked origin keeps its row with `revoked_at` set so the audit
trail and a later restore are both plain. The seed registers `http://localhost:3000` and
`http://127.0.0.1:3000` plus whatever `PURSE_TENANT_ORIGINS` names, so a hosted deploy
registers `https://sideout.<domain>` by seeding; `/v1/origins` (secret key) manages the list,
and the console (phase 5) gets a screen for it.

### The handshake, and where the embed token travels

The frame is opened with the flow, the parent origin and the publishable key in its URL, all
three public. Nothing secret is in a URL: the embed token goes in `hello`, after the frame has
checked the parent against the allowlist and announced `ready` to that exact origin. The SDK
mints the nonce and sends it in `hello`; the frame redeems the token on the Purse origin and
answers `hello_ack` with the nonce and the user state. Both sides drop and count anything
that fails origin, source window, schema or nonce (`drops` on the SDK, `Bridge.drops` in the
frame; the counters share one `DropReason` vocabulary). A second `hello` after the handshake
is `unexpected`; a `ready` after it is ignored. The protocol schemas are `zod/mini` so the
SDK's browser bundle (`@purse/sdk/bundle`, 38 KB) carries the checks it uses rather than the
library; `themeSchema` is applied by the embed as CSS custom properties over the shared
tokens (`--volt`, `--bg-base`, the radii, `--font-ui`), with `--on-volt` picked by the
accent's luminance so text on a partner's colour stays readable.

### The session cookie, and the local-dev exception to `Secure`

`purse_session` is a signed, stateless cookie (HMAC-SHA256 under a key derived from the
process secret, tenant and user inside, 24 hours) set `HttpOnly; Secure; SameSite=None;
Partitioned` as rule 1 requires: `None` because the frame that sets and reads it is
cross-site, `Secure` because `None` requires it, `Partitioned` (CHIPS) so the browser keys it
by the embedding site and third-party cookie blocking does not discard it. The same cookie
serves the headless read: a partner page's `fetch` to `GET /v1/embed/state` with
`credentials: 'include'` is in the same partition as the frame, so it sees the session. The
local-dev exception: Chrome and Firefox treat `localhost` as a secure context and accept a
`Secure` cookie over plain HTTP there, which is why `pnpm dev` works without TLS; Safari
does not, and a partner testing in Safari needs an HTTPS tunnel. A session is bound to the
tenant whose key redeemed the token, so another tenant's publishable key never reads it.

### One process secret, keys derived per purpose

`PURSE_SECRET_KEY` (at least 32 characters) is the one secret the process needs beyond the
database; HKDF-SHA256 with a purpose label derives the session key, the sign-in code key and
the webhook-secret encryption key from it (`src/secrets.ts`), so no two purposes share a
key and rotating the one variable rotates them all (which signs everyone out and, for
webhook secrets, needs a re-encryption pass the console can run in phase 5; until then a
rotation is a re-create of the endpoints). Production refuses to start without it; outside
production a documented stand-in is used and the boot log says so, the same shape as
Sideout's `SESSION_SECRET`.

### Webhook signing secrets are encrypted at rest, not hashed

An API key can be stored as a hash because Purse only ever checks one; a webhook signing
secret must come back in the clear because Purse signs with it. So `webhook_endpoints.
signing_secret` holds an AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ciphertext>`) under the
derived `webhook-secrets` key with the endpoint id as associated data, and a database dump
alone reveals nothing. The plaintext (`whsec_` and 32 random bytes) is returned once, on
creation and on rotation; the idempotent replay of either request carries `secret: null`,
and no read ever returns it. `verifyWebhook` accepts several `v1` signatures in one header,
so a receiver mid-rotation can be given both secrets by a future "rotate with overlap";
today a rotation replaces the secret at once.

### The dispatcher is an in-process worker over the delivery table

Emitting an event is an insert into `webhook_deliveries`, one row per enabled endpoint that
subscribes to the type, in the transaction that made the change (`transition`,
`enterContest`, `withdrawEntry`, `startVerification`, `postEntry`); the table is the outbox,
so nothing is announced that did not commit and nothing that committed goes unannounced.
There is no separate events table: a tenant with no subscribed endpoint produces no row and
no event id, and an endpoint created later does not receive history. The dispatcher runs
inside the API process (`WEBHOOK_DISPATCHER=off` for a process that should only serve),
polls every `WEBHOOK_POLL_INTERVAL_MS`, and leases due rows with `FOR UPDATE SKIP LOCKED`
plus a `locked_until` that outlives the ten-second request timeout, so several replicas or a
restart mid-flight never attempt one delivery twice and a crashed process's lease expires.
`wallet.balance.changed` fires from `postEntry` for every wallet an entry touches, with the
balance after the entry as read under the lock; a tenant with no subscriber pays one indexed
lookup per post. `contest.settled` is emitted by the settling transaction, so it reaches the
partner only once the payouts are committed.

### The retry schedule, `dead`, and replay as a new delivery

Eight attempts: the first at once, then 1 m, 5 m, 15 m, 1 h, 3 h, 6 h and 12 h after each
failure with ±20 % uniform jitter, 22 h 21 m nominal (17.9 to 26.8 hours with the jitter);
the table is `src/webhooks/schedule.ts` and a property test holds its bounds. A 2xx is
`delivered`; anything else, a refused connection or a timeout is a recorded attempt and
`failed` until the next; the eighth failure is `dead`, which is final. Every attempt is an
append-only `webhook_delivery_attempts` row with the response status or the reason none
arrived, never a response body. A replay (`POST /v1/webhooks/deliveries/:id/replay` for the
tenant, `POST /internal/webhooks/deliveries/:id/replay` for the operator) is a new delivery of
the same event to the same endpoint, `replay_of` naming the original, with its own attempts
and its own schedule; the original's history stays as it was, the payload and the event id
are identical, and the receiver dedupes on the id. A disabled endpoint's deliveries wait,
untouched, until it is enabled again.

### Sign-in codes never reveal whether a phone belongs to anyone

The embed's `signin` flow is the phone-and-code sign-in Sideout has, run on the Purse origin
against `users.phone_e164` within the tenant the publishable key names. Because that key is
public, `POST /v1/embed/signin/start` answers "sent" whether or not the phone belongs to a
user and issues a code only when it does, so nobody can use the key to enumerate a partner's
phone numbers; only `verifySignin` refuses, with `invalid_code` in every case that would
otherwise say so. Five codes per phone per ten minutes, five guesses per code, ten minutes'
life, and the count of wrong guesses is committed on its own so it survives the refusal.
The `log` SMS sender echoes the code to the browser outside production (the flow shows it in
the hint) and is refused by the env loader in production, where `none` is the default until
a provider is configured.

## Phase 5 decisions (operator console)

### The console is its own Next.js app on its own origin, talking to `/console/*` server-to-server

Spec 4.10 puts the console at `console.purse.<domain>` "behind its own auth".
`apps/purse-console` is a server-rendered Next.js app (`next start`, port 4200 locally) on
its own origin, not a static export under the API like the embed: it needs a server to
hold the session cookie and to make the API calls, and a separate origin keeps its cookie
jar apart from the embed's `purse_session` on the API origin. The API grew a route group,
`/console/*` (`apps/purse/src/routes/console/`), which is the console's whole surface:
tenants and keys, endpoints and deliveries, the contest browser and close flow, flags and
restrictions, the ledger explorer and `reconcile()`, rulesets and the tester, the audit
log. Every page of the console reads it server-to-server (`src/server/api.ts`) and every
mutation from the browser goes through the console's own `/api/purse/*` proxy, which
appends the path under `/console` and nothing else. The brief's other option, an
operator-scoped secret key in the console's environment, was not taken: a key is scoped to
one tenant, and the console is the one client that must see every tenant, the whole
journal and the platform-wide rulesets. No secret key exists in the console at all, which
`scripts/check-bundle.ts` proves against every build (it fails on `sk_`, `whsec_` or a
session token in `.next/static`; it caught the first draft's own copy).

### Operator accounts and stateful sessions

Operators live in `operators` (email, argon2id hash with the API keys' parameters, role
`admin | operator`, `disabled_at`), created by the seed and the owner role only; the
runtime may change a password hash and nothing else. A sign-in (`POST /console/auth/login`)
mints a 256-bit token, `cst_` and 43 base64url characters, stores its SHA-256 in
`operator_sessions` with a twelve-hour expiry, and returns it once to the console's server,
which keeps it in `purse_console_session`, HttpOnly, `SameSite=Lax`, `Secure` in
production. Sessions are stateful, unlike the embed's signed cookie, so a sign-out, a
password change (which revokes every other session) or a disabled account ends them at
once. Failed sign-ins are charged to the address (ten at once, then one every thirty
seconds); a wrong email and a wrong password are the same `invalid_credentials`, and an
unknown email still costs one argon2 verification so timing does not tell them apart. The
console's proxy accepts a mutation only as `application/json`, which with `SameSite=Lax`
is the CSRF guard. The seed's admin is `admin@purse.local` (`PURSE_OPERATOR_ADMIN_EMAIL`
picks another) with a random 24-character password that exists only in the run that set
it: `db:seed -- --print-operator-password` prints it then, `--rotate-operator-password`
sets a new one and signs the account out everywhere. Expired and revoked sessions are
purged a month later by `db:purge`.

### What `admin` may do that `operator` may not

Both roles review flags, place and lift restrictions, close and void contests, manage
endpoints and replay deliveries: the daily work. Only an `admin` changes what the platform
is: a tenant's status, API keys (create, revoke), and rulesets (publish, activate). The
check is `requireAdmin()` on those routes and the console hides the controls; the API is
the authority. Creating and disabling operators is not in the console yet (the seed and
the owner role do it), noted as a follow-up.

### Console mutations are idempotent per tenant, and platform-wide ones at the service level

The v1 idempotency middleware was generalised (`tenantOf`, `keyPrefix`): under
`/console/tenants/:tenantId/*` every mutation takes an `Idempotency-Key`, stored in that
tenant's namespace with the `console:` prefix so a partner's keys and the console's never
meet, and replayed from the stored response like a partner's. The console's client mints
one key per user action and reuses it for a retry, so a double click never closes a
contest or mints a key twice. Mutations outside any tenant (ruleset publish and activate,
the session routes) take no key and are idempotent at the service level: the same body
under a used version returns it, a different body is `conflict`, activating the active
version changes nothing, and a second sign-out is a no-op.

### `GET /console/reconcile` answers 200 with a failed report

`/internal/reconcile` answers 500 on a failed invariant so a scheduler can alarm on the
status. The console's copy answers 200 with the same report either way, because the panel
renders a failed invariant red with its detail, which is more useful to the operator than
an error envelope; the log line still says `reconcile failed`. The panel runs it on
mount, on demand and every sixty seconds while open.

### The seed's fourth contest

The console's close flow needs an `operator_close` contest in `awaiting_settlement` to
demonstrate, so the seed adds `seed-awaiting-doubles` (four entrants, every score in) to
the draft, open and settled ones. Closing it from the console settles it for good; a rerun
of the seed does not recreate it, which is the seed's contract for every contest.

### Where the console's tests run

Route tests (`apps/purse/test/console/`) cover every console endpoint with a refusal and
a success; component tests (`apps/purse-console/test/`) cover the close flow's two steps,
the invariant panel with a failed invariant, and the tester; the Playwright smoke
(`apps/purse-console/e2e/`) signs in as an e2e admin the seed creates and prints for that
run, drills from the settled seed contest into its settlement entry and sees the lines
balance, queries a point-in-time balance and runs the panel to green. CI runs it after the
build against the seeded `purse` database.

## Phase 6 decisions (Sideout domain)

Two of these need the captain before the public deploy, one is a follow-up, and the rest record how phase 6
answered questions the spec leaves to the builder.

### SMS provider — needs the captain's choice before public deploy

Phone sign-in (`POST /api/auth/request-code`, `POST /api/auth/verify`) sends its one-time
code through the `SmsSender` seam in `apps/sideout/src/server/auth/sms.ts`. Two
implementations exist: `log`, which writes the code to the structured log and is refused by
the env loader in production, and `unavailable`, which is what production gets with no
provider configured: request-code answers `sms_unavailable` (503) and issues no code. No real
provider is wired. **Before the public deploy the captain chooses one (Twilio, Telnyx, ...)**
and phase 9 adds the implementation behind the same interface plus its credentials to the
Railway variables. Until then, production sign-in does not work by design rather than
pretending to.

### Stripe account — needs the captain's account before public deploy

Donations go through `DonationProvider` (`apps/sideout/src/server/donations/`). The `stripe`
implementation talks to Stripe's REST API with test-mode keys from `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`, one PaymentIntent per registration with the donation id as the
idempotency key, and `POST /api/webhooks/stripe` verifies the signature over the raw body and
applies events idempotently on their id. The `dev` implementation is selected automatically
outside production when no key is set and marks a donation succeeded after a short
clock-driven delay. In production with no key, registration refuses with
`donation_provider_unavailable` (503). **The public deploy needs the captain's Stripe
account**: its test-mode (then live-mode) keys and a webhook endpoint pointed at
`/api/webhooks/stripe`. Tests never reach Stripe's network; the provider takes an injected
`fetch` and the webhook tests use recorded fixtures.

### Double elimination — follow-up, not built

`double_elim` stays in the `tournament_format` enum, but the organizer API does not offer it:
`createTournamentSchema` and `updateTournamentSchema` accept only `DRAWABLE_FORMATS`, so an
event that the engine cannot draw can never be created, opened and paid into. The engine
itself still refuses the value at draw time with `double_elim_unsupported` (409) and writes
nothing (`assertDrawableFormat` in `apps/sideout/src/domain/draw.ts`), which is what any row
that reaches it by another route gets. A losers bracket with its crossover rounds and
grand-final reset is a separate piece of engine work with its own property tests; it is a
follow-up after phase 8, at which point the schemas widen to the enum.

### The `forming` team status

The brief's team enum was `registered | checked_in | withdrawn`. A team exists before it is
registered: the captain creates it and names a partner by phone, the partner joins, and only
then does the captain register (make the donation). That gap needed a state, so `forming` was
added ahead of `registered`. Only `registered` and `checked_in` teams count toward capacity,
appear in public responses, or enter a draw. A donation that fails with no other live payment
returns the team to `forming`; a full refund withdraws it.

A captain who mistyped the partner's number, or whose partner never came, is not locked out:
`POST /api/teams` supersedes the caller's own still-`forming` team in that tournament (its
invite is revoked and it is withdrawn, both audited) and creates the new one. A team that has
registered is final for that captain: a second team gets `already_on_team`.

### Partial refunds, and refunds that arrive out of order

Stripe sends `charge.refunded` for partial refunds too. The receiver reads `refunded` and
`amount_refunded` from the charge: only `refunded: true` moves the donation to `refunded`. A
partial refund leaves the donation `succeeded` and the team in place, and records the running
total in `donations.refunded_cents`; the impact figures sum `amount_cents - refunded_cents`
over succeeded donations, so a $5 goodwill refund lowers the total by $5 rather than removing
the entry.

Stripe does not order deliveries, and a refund proves a charge existed, so `refunded` is
reachable from `pending` and `failed` as well as from `succeeded`, and it is terminal: a
`payment_intent.succeeded` that lands after the refund is recorded as
`donation.succeeded_after_refund` in the audit log and changes nothing. A full refund
withdraws the team on every path, unless another succeeded donation still pays for the same
entry (the duplicate-payment case below), in which case the team keeps its place.

### Registration reserves the spot, the provider confirms it

`POST /api/tournaments/:slug/register` runs two transactions: the first validates and marks
the team `registered` with a `pending` donation, the second records the provider's
reference. No database lock is held across the provider's network call. A provider failure
marks the donation `failed`, which releases the spot, and the captain can register again. A
declined attempt (`payment_intent.payment_failed`) is not a failure: Stripe keeps the intent
open for a retry, so the donation stays `pending`, the reservation keeps holding the place
until it lapses, and the decline is recorded as a `donation.payment_failed` audit row and in
`donations.last_payment_error` (shown on `/api/me` while the payment is pending). Only
`payment_intent.canceled` maps to `failed`. The Purse contest entry is not part of this route yet: `PurseContestEntry` in
`apps/sideout/src/server/registration.ts` is the documented hook phase 7 fills, its default
does nothing, and the response says `purseEntry: { status: 'not_wired' }`.

### Unpaid reservations lapse

A `pending` donation is a reservation, not a place. It holds the place for
`RESERVATION_TTL_MINUTES` (env, default 30; the response carries `reservationExpiresAt`),
judged lazily whenever capacity is read (`apps/sideout/src/server/field.ts`); there is no
background job and the donation row is never touched by the clock, so a late Stripe event is
still recognised. Capacity, the public team list and the "every team is in the draw" guard
before `live` count teams whose donation succeeded (or whose entry was free) plus reservations
that have not lapsed; a draw includes only teams whose donation succeeded. Once a reservation
has lapsed the captain may register again for a fresh payment.

A payment that succeeds late is honoured only if there is still a place for the team. There
is none when the event is full (`event_full`), when the field is already fixed because the
tournament has gone live or beyond (`registration_closed`), when the team has already
withdrawn (`team_withdrawn`), or when another succeeded donation already pays for the same
entry (`duplicate_payment`). In every such case the donation stays `succeeded` (the money was
taken), the team is withdrawn or left as it was, and an audit row `donation.refund_due` names
the reason, amount, currency and provider reference the organizer must refund; the webhook
response and the dev provider's audit row carry `registration` and `refundDue`, never a silent
success. Refunding through Stripe then flows back through `charge.refunded` as usual.

Once one payment pays for an entry, the team's other unfinished payments are cancelled at the
provider (`DonationProvider.cancelPayment`; Stripe cancels the PaymentIntent, the dev provider
marks its row `failed` at once, since it has no webhook to do so later): when a captain
registers again after a lapse and when a replacement payment succeeds through the webhook. It is best effort and runs outside any transaction; a
cancellation the provider refuses is logged and the local row is left for the provider's own
`payment_intent.canceled` event to settle. `/api/me` reports each team's and donation's
`holdsPlace` and `reservationExpiresAt` under the same rule, so a captain can see that a place
was released without attempting to register.

### Reopening registration discards the draw; going live needs everyone drawn

`registration_closed → registration_open` deletes the pools, pool memberships and matches of
any draw (nothing can have been played while registration was closed; the transition refuses
if anything has) and clears `draw_config`, with a `tournament.draw_discarded` audit row. The
`live` transition additionally requires the draw to cover exactly the teams holding a place,
and says which remedy applies: `teams_not_drawn` lists confirmed teams the draw missed
(redraw), `teams_withdrawn_from_draw` lists drawn teams that no longer hold a place, such as an
entry refunded after the draw (redraw), and `teams_unpaid` lists teams whose reservation has
not lapsed but whose payment has not landed, each with its `reservationExpiresAt` (wait for the
payment and redraw, or for the lapse). A team that paid after the draw means a redraw, not a
silent exclusion, and a team that left after the draw means a redraw, not a walkover.

Forfeits are recorded only while the tournament is `live` (`tournament_not_live` otherwise):
before that the draw stays replaceable, and a team that pulls out is handled by a redraw rather
than by a result.

### Pools never hold a single team

A pool size of 2 with an odd field would leave one team alone in its pool, playing nothing and
topping its standings by default. The draw refuses any configuration whose balanced pools would
hold fewer than two teams (`invalid_pool_size`), naming a pool size that works.

### The advancement rule is checked when the pools are drawn

A pool-to-bracket event cannot redraw its pools once it is live, and the bracket stage is
only reachable while live, so an advancement rule the pools cannot satisfy would leave the
event with no exit but `cancelled`. The pools stage (preview included) therefore checks the
rule against the partition it just produced before anything is persisted: every wildcard
must have a team left to take (`advancement_exceeds_field`), and what advances must fit a
bracket of two to sixty-four (`too_few_teams`, `too_many_teams`). Each refusal names the
nearest rule that fits (`checkAdvancement` in `apps/sideout/src/domain/draw.ts`; the bracket
stage runs the same check, which then cannot fail). Pinned by "refuses at the pools stage,
preview included, an advancement rule the bracket could not draw" in
`apps/sideout/test/api/draw.test.ts`.

### Ties at a cut line are drawn by lot

The standings tiebreak order (`apps/sideout/src/domain/standings.ts`: wins, head-to-head, set
ratio, point differential, points for) leaves teams that are level on all of it sharing a
rank, and the id order that follows only fixes how they are displayed. When such a tie
straddles a place that advances, the last of a pool's top `perPool` or the last wildcard across
pools, the classic rock-paper-scissors pool, the draw breaks it by a drawing of lots: the tied
teams are shuffled with the draw's `Rng` seeded from the persisted `rngSeed`
(`resolveCutLineTies` in `apps/sideout/src/domain/draw.ts`), so the outcome is reproducible
and never falls to the team id. Once every pool match is complete (the same precondition the
bracket draw enforces), the public standings apply the same lots under the same seed, so the
rows a lot ordered show distinct ranks and `tiebreak: 'lot'` and the standings show exactly
what the bracket will take; while pool play is still going, level teams simply share a rank,
since a lot drawn over an unfinished pool would change with every result. The bracket draw
result and its `tournament.drawn` audit row record every lot with the tied teams and the order
drawn. Ties that touch no cut line stay shared.

### The bracket of a pool-to-bracket event takes no configuration

Its courts, best-of, rng seed and advancement rule were fixed at the pools stage and its
seeding comes from the standings, so `POST .../draw` with `stage: 'bracket'` on such an event
accepts nothing but `stage`: any other field is a validation error rather than a knob that
is silently ignored. The bracket of a single elimination, which is that event's first stage,
takes the first-stage knobs (courts, rng seed, best-of, entry seeds); pools-stage-only knobs
(`poolSize`, `advancement`, `bestOf.pool`) are validation errors at any bracket stage.

### The public detail keeps every team the draw refers to

`GET /api/tournaments/:slug` lists in `teams[]` every team holding a place plus every team the
persisted draw still refers to (a pool member, a match side or a winner), each with its
`status`, so a team withdrawn after the event went live can still be rendered in its pool,
its matches and its opponents' results without a second request. `teamCount` remains the
counted set.

### Default display names never derive from the phone

A first sign-in without a name gets `Player` plus the last four characters of the opaque user
id, never any part of the phone number, since display names are public (rosters, match views,
donors). `/api/me` reports `displayNameIsDefault` so the profile screen can prompt for a
real one.

### Moving `startsAt` moves the schedule

Every match's `scheduled_at` is derived from the tournament's `startsAt` at draw time. When
`startsAt` changes and matches exist, every scheduled match shifts by the same delta in the
same transaction (`matchesRescheduled` is recorded on the `tournament.updated` audit row);
once any match has started, the change is refused with `schedule_in_play`.

### Settlement needs the bracket

For `pool_to_bracket` and `single_elim`, `awaiting_settlement` requires the bracket to have
been drawn (and, like every format, every match complete); a tournament whose pools finished
but whose bracket was never drawn is refused with `bracket_not_drawn`, since there is no
champion to settle. Round robin has no bracket and settles on its pool.

### Cents are decimal strings on the wire

Every `*Cents` field in Sideout's API is a decimal string (`"5000"`), in both directions: a
request body that sends a JSON number is refused with a validation error rather than parsed
through a double. Inside the server every amount is a `bigint`; the JSON encoder
(`server/http/respond.ts`) renders any stray `bigint` as a string so no response can fail on
one. This keeps floating point out of the money path on both sides of the boundary.

### The dev-only login route is absent from production builds

`POST /api/dev/login` signs in as a seeded user without a code. Its file is
`route.dev.ts`, and `next.config.ts` lists the `dev.ts` page extension only when
`NODE_ENV !== 'production'`, so a production build has no such route rather than a disabled
one. `test/auth/dev-login.test.ts` executes `pageExtensionsFor` and proves that half; the
file naming is not asserted from the source tree, because a listing of `src/app/api` proves
nothing about what Next builds. The proof of runtime behaviour, a check that the production
build's route manifest has no `/api/dev/login`, is phase 9's, alongside the deploy it guards.

### Client address behind proxies

Route handlers never see the socket. Next's server sets `X-Forwarded-For` from the socket
when the header is absent; each trusted proxy appends the address it saw. `TRUSTED_PROXY_HOPS`
says how many entries to count back (Railway: 1). With no proxy the last entry is used, which
a direct client could supply themselves, so the per-address limit is backed by a per-phone
limit and a global limit in `server/context.ts`.

### Sign-in codes: any live code verifies, and the SMS budget is a variable

Requesting a code is unauthenticated, so a stranger who knows a number can ask for codes in
its name, and `POST /api/auth/verify` is unauthenticated by nature. What is guaranteed:

- A new request never touches the codes already out for a number. Every unexpired,
  unconsumed code verifies (the set is bounded by the ten-minute expiry, not by any
  limiter, so a restart or a second instance changes nothing), and a successful sign-in
  consumes every code out for the number.
- `request-code` returns the code's id and `verify` names it, so wrong guesses count against
  that one code (five, then `code_locked`). A stranger holds only the ids of the codes they
  asked for, so their guesses can lock only those; the owner's own code stays usable.
- Verify attempts are limited to five per client address per ten minutes, and a code request
  is charged to a cap only after every cap (phone, address, instance) has allowed it, so a
  refused request never spends the number's window or the SMS budget.

The contract this puts on the sign-in screen (phase 8), confirmed: `verify` checks only the
code whose id it names, so a screen that lets the player request again must keep the latest
`codeId` and tell them to use the most recent message; a code from an earlier message is live
but answers only to its own id, and a guess against the wrong id costs one of that code's
five. Outside production the `request-code` response echoes the code together with a `hint`
that states this. The verify limit is a separate counter from the request limit, sharing the
same five-per-address setting, also confirmed: one sign-in is one request and one verify, and
sharing a single counter would have halved the sign-ins possible behind one address.

What a stranger can still do is spend the number's three requests per ten minutes, which the
owner sees as `too_many_requests` when asking for another code; the code they already have
keeps working.

The global cap is the instance's SMS budget and lives in `AUTH_CODE_GLOBAL_CAP` (default 600
codes per ten minutes, so 3,600 messages an hour at most: roughly a hundred dollars an hour at
a few cents a message, and more for international destinations). Lower it if that is more
than the SMS account should be able to spend in the worst hour once phase 9 wires the
provider; the per-address and per-phone caps are fixed in code.

### Dev donations settle when their status is read

The `dev` provider has no webhook. Instead, the endpoints that report donation status
(`/api/tournaments/:slug/impact`, `/api/me`) first settle any pending dev donation older than
`DEV_SETTLE_DELAY_MS` as of the request's clock. This is the same "reconcile against the
provider before reporting" step a production deploy performs against Stripe's records, and it
never runs in production because the dev provider is never selected there.

## Phase 7 decisions (Sideout consensus and the Purse wiring)

### What a player's Purse score is, and when an attempt is finished

Purse holds one counting score per entrant per contest and ranks entrants by it to settle;
a finished attempt is final and cannot be superseded (phase 2). A tournament has many
matches per player, so a per-match score pushed as a finished attempt would refuse every
player's second match. Phase 7 therefore pushes two kinds of score, both through
`POST /contests/:id/scores` (`apps/sideout/src/server/purse/scores.ts`,
`src/domain/purse-score.ts`):

- **A running score at every agreed match**: each player's team's match wins so far,
  `attemptFinished: false`, `sourceRef` the match id, under the key the consensus minted at
  `agreed`. Purse lets an unfinished attempt be superseded, so the next agreed match simply
  advances it.
- **A final score once every match is complete**: derived from the tournament's final
  standings (`src/domain/final-standings.ts`: bracket placement by the round a team left,
  semifinal losers sharing third; pool-to-bracket places the teams the bracket left out after
  every bracket team by the draw's cross-pool order; round robin by its standings) as
  `teamCount - placement + 1`, `attemptFinished: true`, `sourceRef` the tournament id, under
  one key per tournament (`<external id>:final-standings`). A strictly better placement is a
  strictly higher score and tied teams share one, so Purse's ranking (score descending, ties
  shared under `split_evenly`) reproduces Sideout's standings exactly. Purse then holds every
  expected result and moves to `awaiting_settlement` by itself; `finish` covers an entrant
  Sideout could not place (a Purse participant on no confirmed team), who is scored `null`
  and places last, as spec 4.4 rule 5 says a no-show does.

Only players Purse holds as entrants are scored, in both pushes: Purse refuses a batch
naming anyone else, and a player who holds no stake has nothing for Purse to settle. A
match none of whose players hold an entry has nothing to push and is confirmed as such,
with the audit row saying so.

### The `confirmed` rule

`pushed_to_purse` is Purse's 201 to the scores batch. `confirmed` is Purse's answer to the
same request sent again under the same key: `Idempotent-Replayed: true` with the same score
ids. Purse emits no event for a score, so the read-back that proves the batch is durably
held is the idempotent replay itself, which also exercises the contract's rule 4 (a replay
creates nothing new) on every match. A failure at either step leaves the consensus where it
was with the failure on the row (`last_push_error`) and in the audit log; the organizer's
retry (`POST /api/admin/matches/:id/purse/retry`) re-sends under the same key, so from
`pushed_to_purse` the first send is itself a replay and the second the confirmation. A
tournament's close is blocked while any match is `disputed`, `agreed` (never accepted) or
`pushed_to_purse` (never confirmed), and the preview names each with why.

The one audited exception to "one key per consensus": Purse stores a refusal under its key,
so a batch Purse refused (a player disqualified in Purse after the read-back, say) and later
changed would hit `idempotency_key_reused` for ever. An organizer's retry that meets that
conflict rotates the key (`consensus.key_rotated`, with the previous key and Purse's answer)
and sends once more. A player's submission never does.

### Prize structure from sponsor contributions

Sponsor prize contributions are real dollars put up for goods, and they never enter Purse
(spec 4.2.6). What they shape is the split: sorted largest first they become a
`placement_table` of amounts, which Purse treats as weights over the escrowed pool
(phase 2), so the presenting sponsor's prize is first place's share, the next contribution
second place's, and so on. A tournament with no contributions splits `[50, 30, 20]`, the
spec's own example. Purse places players, and a team's two players always tie, sharing the
combined prize of the placements they occupy (`split_evenly`), so each team-level share is
laid out as two player-level placements of the same weight: 50/30/20 of teams is
50/50/30/30/20/20 of players, and the champions, tied first, share the two 50s, half the
pool (`domain/purse-score.ts`). The contest is
`POINTS` (decision D3's free-to-play asset) with a stake of 100
per player; linking a Purse account grants 1,000 welcome points once, under a fixed key, so
the free entry is affordable. Expressing the sponsor pool itself as `CREDIT` in escrow would
need a sponsor-funding entry Purse's v1 API does not expose (`sponsor_funding` exists only as
a ledger account); a follow-up when it does.

### Entry verification, and where the entry is made

Each player makes their own entry in Purse's iframe (`flow: 'entry'`, a single-use embed
token minted server to server for their linked user, `/t/[slug]/enter`), on a surface
visibly apart from the donation. Sideout never trusts the page: `POST /api/teams/:id/purse/entries`
reads the contest's entrants back (`GET /contests/:id/preview`, which lists them in every
state) and records one `purse_entries` row per participant, keyed by the Purse user id so a
participant Sideout cannot match to a player (an "extra") is still recorded. The
`contest.entry.created` and `.withdrawn` webhooks upsert the same rows. The organizer's
reconciliation (`GET /api/admin/tournaments/:id/purse`, the close page) lists every player of
a confirmed team with whether Purse holds their entry, the missing and the extra.

### Mirroring the tournament, and when the contest is locked

The contest is created and opened when registration opens, locked and started when the
tournament goes live, voided when it is cancelled, closed by the organizer through the frozen
preview; every step is idempotent under a key derived from the tournament's opaque
`purse_external_id`, and runs after the tournament's own transaction commits (never a lock
held across a call). Purse has no unlock, so the contest is locked at `live`, not at
`registration_closed`: Sideout's registration can reopen, and a team finishing its Purse
entry after the organizer closed registration is exactly what the second registration step
needs. A mirror that fails is audited (`tournament.purse_mirror_failed`) and reported in the
response, never fatal to the transition; the next transition, the entry step or the close
preview runs the same mirror again.

### The close is keyed by the frozen preview

Purse stores a refused close under its idempotency key (a stale hash is the answer to that
request). Sideout's close key is therefore `<external id>:close:<hash>:<previewed at>`: a
preview the organizer confirms is one request, a later preview that happens to produce the
same hash is another. A close Purse refuses for `preview_hash_mismatch` clears the frozen
preview. A close confirmed again with the same hash on a settled tournament replays.

### Contest value in Sideout's database

No column holds a `POINTS` or `CREDIT` amount of Sideout's own, and the schema test holds
the column names to it. What Purse said is kept verbatim as an audit: `purse_calls.response_body`
and a tournament's frozen close preview. The wallet is never stored; `wallet.balance.changed`
is recorded and audited against the linked user, and the profile reads the wallet back live.

### Rate limits and the audit of calls

Every request to Purse is a `purse_calls` row, written before the request leaves and completed
after, on the pool rather than in a caller's transaction, with bodies scrubbed of anything
key-shaped (`src/purse/redact.ts`). A 429 is retried after Purse's `Retry-After` up to four
attempts, each its own row; Purse stores no 429 under an idempotency key, so the repeat is
safe. The seed's walk over three tournaments meets the default limit and waits it out.

## Phase 8 decisions (Sideout UI)

### One component mounts the SDK

`@purse/sdk` reaches the browser through `apps/sideout/src/components/purse/PurseGate.tsx`
and nowhere else: the ESLint boundary (`sideoutSdkGate` in
`packages/config/eslint/boundary.js`) refuses the import in every other file under
`src/app`, `src/components` and `src/lib`, and `test/purse/sdk-gate.test.ts` proves the rule
holds. The gate links the account, mints the embed token, calls `Purse.init` once with the
Sideout theme, and mounts a flow either into its own bottom sheet (identity, wallet, rewards)
or into a slot a screen registers (the contest-entry step of the register screen). What a
flow returns is mapped by the pure `mapPurseError` (`components/purse/eligibility.ts`) into
four UI states: `terminal` (`identity_rejected`, `platform_blocked`, `under_minimum_age`,
`region_not_permitted`: a plain row, a support link, no retry button), `action` (the flow
that clears it), `retry`, and `unavailable` (the server has no publishable key, or Purse
does not answer). The profile is read from `GET /api/me/purse` on every mount and never
stored; the wallet chip shows what Purse says now.

### Live data is polling (D11)

`LiveRefresh` calls `router.refresh()` every five seconds on the home strip, the
tournament tabs of a live event and an open match, and stops while the tab is hidden. The
count-up, the FLIP reorder and the bracket draw animate the difference between two server
renders: there is no client store, and a refresh that changes nothing moves nothing. SSE
stays the phase 9 follow-up the spec names. (Delivered as stretch item 3: "Stretch: SSE
live scoring decisions" at the end of this file; the poll is now the fallback.)

### The service worker is a production-build feature

`public/sw.js` is registered only by a production build (`NODE_ENV === 'production'`,
inlined by Next): `next dev` serves chunks under `/_next/static` that are not immutable,
and a cache-first worker would keep running stale code; a dev session unregisters any
worker a previous production build left on the origin. The worker is versioned by the
build sha in its query string (`/sw.js?v=<sha>`) and `/sw.js` itself is served with
`Cache-Control: no-store`, so every build starts from empty caches and drops the previous
build's on activation. It precaches the offline page and the icons, keeps the pages a
player opened (never `/sign-in`, `/organizer/*`, `/admin/*` or any API route other than
the public tournament, match and profile reads), answers a navigation from the network
first and from the cache after four seconds, and drops the pages and API caches on the
`clear-pages` message a sign-out sends. To run the PWA locally: `pnpm --filter @sideout/web
build && pnpm --filter @sideout/web start`.

A consequence for the end-to-end run: it needs `next start`, and a production build has no
`/api/dev/login`, so `apps/sideout/e2e/session.ts` mints session cookies with the app's own
`issueSession` under a `SESSION_SECRET` that `playwright.config.ts` hands the server for the
run. No login bypass exists in the build; the test knows the secret because it configured
the server.

### The outbox: one queued scoreline per match, replayed through the same route

A scoreline submitted with no connection (or when the request fails with no status or a
5xx) is written to IndexedDB (`src/lib/offline/outbox.ts`) as the exact body
`POST /api/matches/:id/scores` takes, latest per match wins, and is replayed on page load,
on `online` and when the tab becomes visible, through the same route with the same
validation and the same consensus path. A transient failure leaves the item queued; a 4xx
marks it `failed` and the match page shows the refusal with a way to discard it;
`match_not_open` and `already_decided` mean the match was settled without it and the item is
dropped with a neutral toast. The UI never says "sent" for a queued item: the sheet says
"Saved on this phone", the match page shows the queued scoreline in match orientation, and
the shell's status line counts what is waiting.

### Stripe in the browser is optional outside production

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is public by design and optional: the Payment Element
mounts only when it is set, and without it the register screen says the card form is
unavailable rather than pretending. The `dev` donation provider needs no key (it settles
its own pending donations, phase 6). A checkout interrupted by a reload resumes from
`GET /api/me/donations/:id/payment`, which asks the provider afresh (`retrievePayment`, the
third method of the `DonationProvider` seam) for the client secret; the secret is never
stored, and the route answers 503 when the configured provider is not the one that created
the donation.

### The console is a 404 to anyone else

`/organizer/*` and `/admin/purse` render for an organizer and answer the same not-found
screen as an unknown path to a player or a visitor (`organizerPageContext`), so the
console's existence is not confirmed by a redirect. The player screens (`/me`,
`/t/[slug]/register`, `/teams/new`) redirect a visitor to `/sign-in?next=` instead. The
`/api/admin/*` routes keep their 403.

### What the profile shows as rewards

Sideout stores no contest value of its own (phase 7). The rewards panel therefore reads the
viewer's placements and payouts out of the frozen close preview of every settled tournament
they played (`server/rewards.ts`); the wallet is read live through the gate. A tournament
closed without a stored preview shows no reward row.

### Where the responsible-play links go

The profile's "responsible play policy" and "limits and self-exclusion" links point at
`/responsible-play` and `/support` on the Purse origin (`server/pages.ts`, `purseLinks`):
Purse publishes the policy and holds the limits, and Sideout does not write a second copy.
Purse serving those two pages is a phase 9 item.

### Sponsors are seeded, not edited

The event builder edits every field the phase 6 API accepts; sponsors have no write API,
so the builder shows them read-only and the seed is their only source. A sponsor editor is
a follow-up.

### The widths, the icons, and the streamed not-found

Tailwind's breakpoints are the spec's three widths (`sm` 390, `md` 768, `lg` 1280), so
`sm:` means "a phone" and two-column layouts start at `md:`. The one icon set is
`lucide-react` at 1.5px stroke, wrapped as `Icons` in `@sideout/ui` so no screen picks a
stroke of its own; the PWA icons are rendered by `apps/sideout/scripts/render-icons.ts`
rather than checked in from elsewhere. A missing event answers the not-found screen inside a
200: the route's loading boundary streams, and Next cannot change the status once the shell
has gone out. The e2e asserts the screen, not the status.

## Phase 9 decisions (polish and host)

### Railway-provided domains, no custom DNS

D12 and spec section 10 default to custom subdomains on a personal domain
(`sideout.<yourdomain>`, `purse.<yourdomain>`, `console.purse.<yourdomain>`). The captain
chose Railway's own domains for now (`*.up.railway.app`, TLS included) and no DNS, the same
as the sibling Sideout-on-Lucra deploy: `docs/deploy.md` lists the three URLs. Everything
that depends on an origin reads it from a variable (`PURSE_TENANT_ORIGINS`,
`NEXT_PUBLIC_PURSE_ORIGIN`, `PURSE_API_URL`, `PURSE_API_ORIGIN`), so custom domains are a
DNS change plus a variable change, not a code change. One consequence worth knowing:
`up.railway.app` is on the public suffix list, so the Sideout and Purse origins are
different *sites* as well as different origins, which is exactly the cross-site case the
embed session cookie was written for (`SameSite=None; Secure; Partitioned`, phase 4), and
the deployed flows prove it.

### Cron: two Railway cron services, not in-process timers

Spec section 10 wants `reconcile()` on a 15-minute schedule and a nightly demo reset. Both
are Railway cron services (a container that starts on its schedule, does the job, exits;
the platform skips a run while the previous one is still going): `purse-reconcile` runs the
Purse image with `node dist/reconcile.js --source schedule` every 15 minutes, `demo-reset`
runs `docker/demo-reset` at 10:00 UTC. A timer inside the API process would have tied the
schedule to the serving process (a restart resets it, a second replica doubles it) and
would have needed the reset's owner-role connection string in the API, which the role model
forbids. The price is a container boot per run, which is seconds. Each run is recorded in
the new `reconcile_runs` table (append-only for the runtime, like the journal), and
`/health` reports the newest row: the "last reconcile result" the spec asks for is now
durable and the same on every replica, which is why phase 1 left it out
(`apps/purse/src/ledger/reconcile-runs.ts`). `GET /internal/reconcile` and the console's
invariant panel record runs too.

### A failing invariant makes `/health` answer 503

"A failing invariant pages you" is implemented as the status code: while the newest
recorded reconcile run failed, Purse's `/health` answers 503 with `status: "failing"` and the
failed invariant ids, so an external check on the status code alone pages, and Railway's
own deploy health check refuses to switch to a new deployment of a ledger that does not
reconcile. That last part is deliberate: a deploy onto a broken ledger is not something to
do quietly. The console's `GET /console/reconcile` still answers 200 with a failed report
(phase 5), because the panel renders it. Sideout's `/health` relays Purse's state in a
`purse` field and never inherits the 503: it is Sideout's health.

### The demo reset is a job, protected by the role model

The sibling protects its reset with a bearer token on an HTTP route. Here the reset must
delete journal rows, which only `purse_migrator` may, and the API process must never hold
that role (phase 1; the Purse entrypoint even unsets the migrator URL before serving). So
the reset is not a route: it is a container (`docker/demo-reset`) that holds the owner
role's connection string and an explicit `DEMO_RESET=allow` switch, refuses any database
not named `purse`/`sideout` (or a demo or test one), and is started by Railway's cron or by
`railway restart`. What it keeps on Purse is the tenant's configuration and the platform's
record (tenants, origins, API keys, webhook endpoints, the ruleset, operators, sessions,
`reconcile_runs`); everything the demo produces, journal and audit log included, is deleted
and reseeded. Sideout is emptied and reseeded whole, then mirrored to the fresh Purse
through the API, so the reseeded contests are the ones the seeded events point at. The
Sideout e2e global setup runs the same two halves locally, which is how a rerun of the
flows starts from the seed rather than from what the last run left behind.

### Seeds: every state, in two places

Purse's seed now holds one contest per resting state (`draft`, `open`, `locked`,
`in_progress`, `awaiting_settlement`, `settled`, `cancelled`, `voided`; `settling` exists
only inside the settlement transaction) and a seventh user, verified but `platform_block`ed,
so every verification state and the blocked case are on the console's review screens.
Sideout's seed grew from three events to nine: one per tournament status (a draft, a
drawn-but-not-live event, a cancelled one whose contest is voided with every stake
refunded) and three the end-to-end flows drive (the free-entry Community Cup, the
Boardwalk Invitational mid pool play, the Dune Cup complete but for a disputed final). Players
are drawn from the same roster of 48, so a player is in several events, as people are.
`awaiting_settlement` on Sideout is the one status the seed does not write: it is the step
the organizer takes before the close, which the Organizer flow performs.

### The images bundle the scripts; no `tsx` in production

Purse's `tsup` build now emits the operational scripts (`migrate`, `seed`, `reconcile`,
`purge`, `demo-reset`) next to the server as flat files, and Sideout gained a `tsup` build
for its scripts plus a compiled `next.config.js` (so `next start` needs no TypeScript
installed), so the runtime images carry `dist/`, the migrations and production
`node_modules` only. The Sideout image is still large (Next, its SWC binary, `sharp`,
`lucide-react`); Next's standalone output would shrink it and is a follow-up.

### Purse publishes `/responsible-play` and `/support`

Phase 8 pointed the profile's responsible-play links at the Purse origin without Purse
serving anything there. The API now serves both pages itself (`src/routes/pages.ts`):
static HTML, no script, cacheable, the policy carrying the `#limits` anchor the wallet
links to. They live in the API rather than the embed export because the embed is sized by
its parent and never scrolls.

### Follow-ups this phase leaves

- An SMS provider for both sign-ins and a Stripe account for donations (phase 6's two
  captain decisions) are still unmade; the demo says so plainly (`docs/deploy.md`).
- Custom domains and DNS; a second replica (the rate limiter and the webhook dispatcher are
  in-process); Next standalone output for the Sideout image; SSE in place of polling (D11).
- The `.env.example` templates could not be edited from the automated pipeline (writes to
  env files are denied by policy); `apps/*/src/env.ts` and `docs/deploy.md` are the
  variable lists.

## Stretch: ledger replay decisions

- Replay follows the explorer's existing `(posted_at, id)` order, preserving database
  timestamp precision. Positions are one-based; the default is latest, and an empty
  journal has position zero. Shareable links use entry IDs so later postings do not
  retarget the link. Same-timestamp entries are distinguished by ID.
- One SQL statement provides a consistent read snapshot for position, balances, lines
  and totals. Balances are derived from the append-only journal, without snapshots or
  per-account queries. Account pages contain up to 200 rows in ID order; conservation,
  changed IDs and touched escrows remain complete across pages.
- A changed balance means the net effect of the selected entry against its immediate
  predecessor, even when navigating backwards or jumping. Zero-net accounts are not
  highlighted. Metadata is current; zero-history accounts remain visible at zero.
- Conservation normalizes account sides (credit positive, debit negative) before summing
  per asset. The screen also checks the selected entry's balanced lines and lists historical
  escrows; it does not apply today's contest state to historical balances or claim to run
  all seven invariants historically. The existing live invariant panel remains authoritative
  for the current ledger.

## Stretch: public status page decisions

Spec section 12, item 5: "Public status page rendering the live invariant panel". What
shipped is `docs/status.md`; these are the choices the one line left open.

### The feed is the stored record, never a live run

`GET /v1/status` on the API (also at `/status`, mounted beside `/health` outside the v1
key stack) returns the newest twenty `reconcile_runs` rows and the per-invariant outcome
of the newest one. It never calls `reconcile()`: seven full-table checks on demand for an
anonymous visitor would let anyone make the database work, and the record phase 9 added
already holds what the 15-minute job, the console panel and the internal route found.
"Live" on this page means "as of the last run, refreshed every minute", and the page says
when that run was.

### 200 whatever the last run found

`/health` answers 503 while the last reconcile failed because an uptime check reads the
status code. The status feed and the page answer 200 with `status: failing` in the body:
the page has to be able to render what is wrong, and a 503 on the page would make a
checker see the messenger as down. `docs/status.md` tells the check that pages to stay on
`/health`, and offers `data-status="ok"` as a keyword check on the page.

### What a failing invariant shows

The id and the name (`I3 · no user wallet is negative`), nothing else. The panel's
`detail` sentence quotes sums, counts and ids; the feed strips it and the test pins that
a detail never reaches the wire. The run history shows a failed run as `failing: I3` for
the same reason. Nothing tenant-shaped, no balance and no activity count is on the page;
the migration counts and run durations are the only numbers.

### Cached at both ends, rate limited by address

The API assembles one answer per process every 30 seconds and serves it from memory in
between (`Cache-Control: public, max-age=30`), and the route spends from the address's
token bucket like the embed's routes, so a crawler gets cached answers and then 429s. The
console keeps the feed and Sideout's `/health` for 30 seconds too, so a page view is at
most one round of server-side requests per half minute however many people load it, and
each probe has a three-second timeout.

### Stale for two minutes, then down

When a probe fails the console shows the last good answer marked stale, with the time it
was confirmed, for up to two minutes past that check, then reports the service down; a
failed probe is itself remembered for the TTL so a dead origin is not probed on every
page view. A blip is not an outage, a minute of silence is.

### Meta refresh, no script

The page reloads with `<meta http-equiv="refresh" content="60">`. It is the one
auto-refresh that works without JavaScript, the page carries no script of its own, and a
minute is inside the brief's 30-60 second window; the console's own panel keeps its
60-second timer and its "run now" button, which the public page has no business offering.

### Sideout's origin is a console variable

`SIDEOUT_ORIGIN` on the console, optional, unset locally ("not configured" on the page).
The console already knows the API's origin; Sideout's is the one thing it did not, and a
required variable would have broken the existing service topology. The `.env.example`
template could not be edited from the automated pipeline (the phase 9 note applies);
`src/env.ts`, `docs/status.md` and `docs/deploy.md` carry the variable.

## Stretch: demo accounts decisions

The public demo's sign-in switch (`docs/demo-accounts.md`), ported from the sibling
Sideout-on-Lucra's demo-accounts feature as a pattern, not as code. Production issues no
one-time code without an SMS provider (phase 6, still unchosen) and the dev login is
compiled out, so without this a visitor could read every screen and sign in as no one.

### `DEMO_ACCOUNTS` is a build-time setting with a runtime check

`DEMO_ACCOUNTS=true` on the server enables the picker, `POST /api/auth/demo` and the
`demoAccounts` field on `/health`; off by default. `next.config.ts` derives
`NEXT_PUBLIC_DEMO_ACCOUNTS` from it at build time and `src/env.ts` refuses to boot a build
made for the other setting (a literal `process.env.NEXT_PUBLIC_DEMO_ACCOUNTS` read, which
`next build` inlines; unset, as in the bundled scripts and vitest, means "as the server").
Nothing in today's browser bundle depends on the value: the picker and the pill are
server-rendered. The check exists so a demo build can never be started as a non-demo
server or the reverse, and so the Dockerfile's `DEMO_ACCOUNTS` build argument (default
`false`) and the runtime variable have to be set together on purpose. `NEXT_PUBLIC_DEMO_ACCOUNTS`
is never set by hand; the host sets `DEMO_ACCOUNTS` and passes it to the build. The
refusal is a real one: `src/instrumentation.ts` (Next's boot hook, Node runtime only)
parses the environment before the server serves and exits 1 with one logged line, which
also turns any missing production variable into a failed boot rather than a 500 on every
request.

### Refused beside anything real

With the switch on, `src/env.ts` refuses a live Purse key (`sk_live_`, `pk_live_`), a
Stripe key that is not test-mode (`sk_test_` / `rk_test_`, `pk_test_`), and any SMS
provider that is not the log sender (today the enum holds only `log`; a real provider is
refused by name when one is added). A demo picker must never sign visitors in beside real
money or real identities.

### Production may run the `dev` donation provider under the switch only

Donations are Stripe test-mode only (kickoff) and no Stripe keys are on the deployment, so
registration for a paid event answered 503 there. Under `DEMO_ACCOUNTS`, and only under it,
production selects the `dev` `DonationProvider` when no Stripe key is configured
(`donationProvider: 'dev'`), so the registering captain's card can walk the entry donation
and the Purse entry. A configured Stripe key still wins wherever it is set, so adding test
keys later needs no code change. Outside the switch production keeps refusing without
Stripe.

### The roster is named by seeded phone and resolved against live rows

`src/db/seed/demo.ts` names six accounts from the built dataset by seeded phone number
(the same on every host; ids are stable too, but a phone survives whatever a demo does to
the rows and reads well in a doc). `src/server/demo-accounts.ts` resolves them against the
database on every request and reads each account's live state (the match and whose
scoreline is in, the registrant's team and whether it holds a place, the organizer's
dispute count, the last verification state Sideout heard). A card whose rows are gone is
left out rather than shown broken; `POST /api/auth/demo` takes a roster key only, never a
user id or a phone.

Who they are: the two captains of the Sandbar Classic quarterfinal at bracket position 12
(`awaiting_scores`, team A's reading in; the same match the seed test and the screen
smoke already lean on); the captain of the Pier 9 Open pair whose payment failed (a
complete pair not entered, on a paid event, so the dev provider is what the demo exercises;
the Community Cup's free pair is left to the Player flow); the seeded organizer; and the two
Purse-state players below.

### "Refused" and "mid-verification" with a synchronous dev identity provider

Purse's dev identity provider decides on the spot (verified with a name and a date of birth,
rejected without, pending only for an external id on `DEV_IDENTITY_PENDING`, which is Purse
configuration this feature does not require), and Sideout's contests are POINTS contests,
for which the seeded ruleset does not require verification. So:

- **The refused player** (the Pier 9 captain whose checkout lapsed) is made refused by the
  seed's Purse walk after every seeded entry, so the seeded contests keep their
  participants: `POST /v1/users/:id/verification` (rejected, no date of birth), then an
  upsert carrying a date of birth `DEMO_REFUSED_AGE_YEARS` (16) before the anchor. The
  profile shows the terminal identity row, and any new contest entry is refused
  `under_minimum_age`, terminal too. Purse leaves an omitted field alone on an upsert, so
  the app's later re-links keep the date. This is the honest way to get both a terminal
  profile and a refusing eligibility engine with the sandbox providers as they are.
- **The player still to verify** (the Community Cup captain waiting on a partner) is
  linked and left `unstarted`: the profile's identity row opens Purse's identity flow, and
  the dev provider verifies as soon as a name and a date of birth are supplied. "Mid-
  verification" is read as this, the sibling's "player with details to add", because the
  dev provider has no waiting state without a Purse-side list; the card shows whatever
  state is live, so a Purse configured with `DEV_IDENTITY_PENDING` shows `pending` instead.

### One reset, and the roster survives it

The nightly reset phase 9 built is the reset; the demo step is part of the seed's Purse
walk (`seedDemoAccounts` in `src/db/seed/purse.ts`), which both `db:seed` and the reset run,
so the two Purse states come back every morning with the rows. Every call is idempotent
under a fixed key, so a reseed replays.

### A demo session is a normal session, marked

`POST /api/auth/demo` issues the ordinary session cookie with `via: 'demo'` inside the
signed payload (it cannot be added to a phone session afterwards), writes
`user.demo_signed_in` on the user, and is rate-limited per address (30 per ten minutes) and
process-wide (600), every cap consulted before any is charged, as the phone sign-in does.
The shell reads the mark and shows a fixed fault-red "Demo · name" pill on every screen
until sign-out. The phone form on `/sign-in` and its routes are untouched.

### The e2e builds with the switch on

The switch is inlined at build time, so CI's `pnpm build` runs with `DEMO_ACCOUNTS=true`
and the Sideout smoke walks the picker (`e2e/demo.spec.ts`); the Playwright config starts
the local server with the setting the build was made with (read from
`.next/required-server-files.json`) and the demo spec skips itself when that is off, so a
plain `pnpm build && pnpm e2e` still passes. The deployed image is built by the host from
its own build argument. `E2E_API_PORT` / `E2E_WEB_PORT` move the local e2e servers when a
sibling checkout holds the defaults.

### Not done here

- The deployment: `DEMO_ACCOUNTS=true` on the Railway `sideout` service (the same value
  reaches the build as the Dockerfile's argument), a redeploy, and the "Public demo" note in
  `docs/deploy.md` are the operator's step after this lands.
- `apps/sideout/.env.example` could not be edited from the automated pipeline (writes to env
  files are denied by policy); `src/env.ts` and `docs/demo-accounts.md` document the variable.

## Stretch: second tenant decisions

Stretch item 4: a throwaway second product, an office ping-pong ladder (`apps/pingpong`,
`docs/second-tenant.md`), on the same Purse instance. What was decided, what the second
consumer proved, and what it exposed.

### What it proved

- **A tenant costs a row, six accounts, two keys and an allowlist.** `seedSecondTenant`
  (`apps/purse/src/db/seed.ts`) is the whole of what Purse needed to learn about the ladder:
  a `tenants` row with a stable id, the platform accounts per asset, a sandbox key pair
  labelled `seed:pingpong:*`, and its origins. No migration, no code path in the API, no
  mention of the product anywhere in Purse's source. The ladder imports nothing of Purse but
  `@purse/sdk` and `@purse/types`, and the boundary lint now proves it for two consumers
  (`packages/config/eslint/boundary.js`, `tenantBoundary` over `TENANTS`;
  `test/boundary.test.ts`).
- **The four rules held without being restated.** Its own database and role (`pingpong`,
  `pingpong_app`); the secret key on the server only (`scripts/check-bundle.ts`); the ladder
  owning the outcome (who won, who moved) and Purse owning what it pays (the 50/30 split, the
  frozen preview, the hash the close must repeat); every mutation under an idempotency key
  the ladder chose. The Playwright smoke and the integration walk close a real season with
  real wallets, and the ledger reconciles with both tenants' settlements in it (CI).
- **The embed is genuinely product-agnostic.** The `entry` flow mounted in the ladder's page
  with the ladder's publishable key and tenant id, on Purse's origin, with no change to the
  embed app; the eligibility check and the escrow ran there. A second design surface
  (`@sideout/ui`, the shared design system) dressed it without a line of new CSS beyond two
  rules.

### What it exposed

- **The server client is not published.** The typed `PurseClient` (schemas for every
  resource, the sealed error shapes, redaction, the call recorder, the 429 retry) had to be
  copied from Sideout, and so did the in-memory fake Purse the route tests run against. That
  is ~900 lines a tenant should never write: the follow-up is a server entry in `@purse/sdk`
  (the typed client and the resource schemas) and a published fake, the way payment
  platforms ship a mock server. This is the single largest cost of the second consumer.
- **The contest vocabulary is Sideout-shaped.** `CONTEST_KINDS` is `tournament`,
  `head_to_head`, `pool`; a ladder season is filed as a `pool`. The kind is descriptive only
  (nothing in settlement reads it), so a free-text or extensible kind would cost nothing.
- **The demo reset is per platform, not per tenant.** Purse's nightly reset deletes every
  tenant's users and contests and reseeds Sideout's; the ladder's own reset is a separate
  job, and until it runs the ladder holds Purse ids that no longer exist. The app copes (a
  forgotten user is offered the link again; a season whose contest is gone is closed by
  opening the next), but a platform should reset one tenant's data at a time, or the demo
  reset should be a per-tenant operation the console offers.
- **The entrant read-back is the tenant's job.** A tenant learns that the entry flow
  succeeded from the frame's `flow:complete` (untrusted) and then has to ask Purse who the
  entrants are; Sideout and the ladder both wrote the same "read the preview, diff against
  what we hold" loop. A `GET /contests/:id/entries` (the preview carries them, but as part of
  a settlement view) and the `contest.entry.created` webhook are the two ways in, and neither
  is as simple as a tenant would like.
- **`NEXT_PUBLIC_` names travel further than they should.** The ladder never inlines the
  publishable key (the server hands it to the browser with each embed token), but the
  variables kept Sideout's names for the operator's sake, so the Dockerfile still declares
  build arguments it does not need. A tenant template would settle the names once.

### Decisions the spec left open

- **One role, like Sideout.** The ladder's tables hold no ledger; nothing in them is
  append-only by rule, so the two-role pattern (owner and runtime) that protects Purse's
  journal has nothing to protect here. `pingpong_app` owns and runs, like `sideout_app`.
- **The ladder's rules** (challenge reach 3, one open challenge, one game to 11 won by two,
  the challenger takes the defender's place) are the classic office rules; they are constants
  in `domain/ladder.ts` and nothing in Purse depends on them.
- **What a score means.** Mid-season, a player's Purse score is their wins so far
  (`attemptFinished: false`), so Purse's mid-season view is readable; at the close, the rank
  turned upside down (`attemptFinished: true`), so Purse's ranking reproduces the ladder
  exactly and the split follows it. The final scores supersede the running ones, so a running
  score whose push failed is a gap in the mid-season view, never in the settlement.
- **The season freezes before the preview.** `previewClose` moves the season to `closing`
  in its first transaction, before any Purse call, so the rank set cannot change between the
  final push and the close and the final push's key (`<external id>:final`) is stable across
  retries. There is no reopen; the next season is the remedy.
- **Sign-in is a name and the office code.** A shared secret is the right amount of
  authentication for a throwaway office product and the wrong amount for anything else; the
  production configuration requires a real code and a real session secret, and nothing about
  it is reused by Sideout.
- **Deploying the fourth service** was raised as a decision rather than guessed (the brief
  both asked for the deploy and forbade a new service) and decided as: merge first, then
  deploy from `main`, redeploying the existing services at the same commit before adding
  the new one, so the reset job knows the second tenant before it next runs. It is live
  (`docs/second-tenant.md`, "Deployed"); a service's deploy order relative to the platform's
  images turned out to be the one thing a fourth service needed that the pattern did not say.

## Stretch: SSE live scoring decisions

Stretch item 3 (spec section 12) replaces the polling D11 chose for v1 with Server-Sent
Events; `docs/live.md` is the reference. What the spec left open, and what was decided:

### Events carry no figures; the screen re-renders

An event is `{ tournamentId, kind, matchId, seq, at }` and nothing else. The client's only
reaction is `router.refresh()`, the same call the phase 8 poll made, so every screen keeps
rendering from the server and the six motion transitions keep animating the difference
between two server renders. A client store of live data would have been a second copy of
the truth, and a payload a screen renders directly would have tied the wire format to every
screen. The cost is one server render per event per open screen, which is what the poll
already paid every five seconds; refreshes are coalesced so a burst of events (a submission
emits `score` and `match`, an agreed match `standings` and the next match's `match` too)
costs at most two.

### Fan-out is Postgres NOTIFY, the in-process bus the local leg

Sideout may run as more than one instance, so an event written by one must reach a stream
held by another. The options were a broker (a new service, refused by the hosting topology),
a shared table polled by every instance (a new table and a poll), or Postgres `LISTEN` /
`NOTIFY` on the database Sideout already has. NOTIFY it is: the publisher runs one statement
after its transaction commits, on the tournament's channel (`sideout_live:<id>`) and on the
channel of every tournament (`sideout_live`, for the home strip and the dispute queue);
each instance's bus listens to a channel while a stream on it is open and for thirty seconds
after. The bus is fed by notifications only, the publishing instance's own included, so one
path exists and every instance sees the same order. NOTIFY is not durable across a dropped
listening connection, and need not be: a reconnected listener tells its streams to `resync`
(one refresh), and a client that reconnects with an id the server cannot resume gets the
same answer.

### Sequence and resumption are per process, and a resume that cannot be honoured is a resync

`Last-Event-ID` resumes from a bounded in-memory ring per channel (256 events, thirty
seconds of linger after the last subscriber). An id is `<epoch>-<seq>`: the epoch is random
per process and per continuous listening period, so an id minted by another instance, or
before the listener reconnected, never matches by accident; a gap the ring has evicted
resyncs too. A database sequence would have made ids global at the cost of a migration and
a round trip per event, for a property the client does not need: a stale resume costs one
render, which is exactly what a reconnect deserves.

### After the commit, structurally

The after-commit seam is `liveTransaction` / `emitLive` (`server/live/outbox.ts`). A writer
emits next to its state change (every consensus move, every match move, the winner's
advancement, the forfeit, every tournament transition, the Purse push's consensus moves);
the transaction's owner publishes once it has resolved, so no event precedes its commit and
a rollback emits nothing. A transaction handle not opened through `liveTransaction` throws
on `emitLive` rather than publish early or drop the event; on the pool (the Purse push's
autocommitted moves) `emitLive` publishes at once, the write already being durable. This
mirrors the phase 7 rule that Purse is called only after Sideout's transaction commits.

### Bounds: a 429 with Retry-After, never an unbounded fan-out

Per process (`LIVE_MAX_STREAMS`, 500) and per address (`LIVE_MAX_STREAMS_PER_ADDRESS`, 8,
read with `TRUSTED_PROXY_HOPS` like the sign-in limits) the route answers 429 with
`Retry-After: 5`; the browser's `EventSource` reports that as a failure and the client
falls back to polling. Every stream is closed with `bye` after `LIVE_STREAM_TTL_SECONDS`
(fifteen minutes) so no connection outlives a deploy by much and clients spread over the
instances again, heartbeats every `LIVE_HEARTBEAT_MS` (twenty seconds, the middle of the
15–25 s window proxies tolerate), and a client that goes away frees its slot on the request's
abort. None of the four variables is required.

### The client reconnects by hand and keeps polling as the fallback

`EventSource`'s own reconnect is a fixed delay; the client closes and reopens the stream
itself with exponential backoff (1 s to 30 s, a quarter of jitter), carrying the last id in
the query string since a hand-made connection sends no `Last-Event-ID`. Three short-lived
failures in a row (a stream that lived thirty seconds before dropping resets the count, a
deploy is not a fault) switch the page to the D11 five-second poll for a minute before the
stream is tried again; a browser with no `EventSource` polls from the start. The stream
pauses while the tab is hidden and one refresh catches up on return, the same visibility
rule the poll had.

### A refresh the router parks is retried, because Next 15.5 sometimes never wakes it

Found while proving the Playwright flow, and it predates this work: in a production build
of Next 15.5.25, `router.refresh()` frequently never applies. The app router suspends the
whole tree on the refresh's promise inside a transition (`use(state)` in `useActionQueue`),
and the render React parked is sometimes not woken when that promise settles: the root is
left with the transition lane pending and suspended and `pingedLanes` at zero, the RSC
payload fully received, every later refresh entangled with the stuck one, and the page keeps
its old figures for good (vercel/next.js#98305 describes the same lost ping; the code path
is gone in Next 16). Measured on the seeded event it took most refreshes on the home and
overview screens and about half on the match page, in a single tab as much as in two. The
phase 8 poll used the same call, so it was affected as much; nobody had watched a live
screen long enough to see it.

The mitigation lives in `LiveRefresh`: while a refresh is pending, a state update nobody
reads fires every `PARKED_REFRESH_RETRY_MS` (250 ms). Any non-idle update clears React's
suspended lanes and re-attempts the parked render, which then commits at once (a browser
probe confirmed an unrelated `setState` unparks it). A refresh that settles normally, in
tens of milliseconds, never sees the first tick; a parked one is on screen within a quarter
second (the two-tab flow measured ~350 ms end to end, twelve of twelve). The retry is
removed once the router is on a release without the code path; upgrading Next is not this
change's to make.

### A confirmation holds the refresh until it is dismissed

The score sheet keeps "waiting on", "both teams agree" and "scorelines differ" on screen
until "Done", and the dispute card keeps "settled by" until the organizer moves on; each
defers `router.refresh()` to the dismissal on purpose (phase 7 and 8). An event now lands
within a millisecond of the commit, before the sheet's own answer has arrived, and a
refresh at that moment re-renders the page from a server on which the match is already
final or the dispute already gone, unmounting the confirmation mid-beat. So a confirmation
holds the live refresh (`components/motion/live-hold.ts`, `useLiveHold`): the sheet from the
moment it opens, the card from the moment the resolution is sent. `LiveRefresh` defers an
event that lands under a hold and applies it once when the last hold is released; the
dismissal's own refresh usually gets there first. Other viewers are unaffected; only the
phone that is reading its own confirmation waits, which is what the five-second poll gave
it by accident most of the time. Phase 9's two flows are what caught this.

### The one visible change is the live dot's halo

While the stream is open the page sets `data-live="stream"` on `<html>` and
`.so-live-dot` gains a faint surf halo; polling shows the plain dot. That is the whole UI
change: no new element, no layout change, and the reduced-motion twins are untouched (the
dot's breath is a keyframe; the halo is a static shadow).

### The register screen still polls

Waiting on a pending donation is not live scoring and emits no event; `LiveRefresh` without
a `source` is the phase 8 poll, kept for that screen alone.

## Stretch: signed score attestation decisions

The full contract (keys, the canonical form, the checks on each side, what is recorded and
shown) is `docs/attestation.md`. These are the choices the spec's one-line item left open.

### One shared implementation, in `@purse/types`

The canonical form, the key id derivation and the sign/verify functions live in
`packages/purse-types/src/attestation.ts`, the one Purse package a partner's browser code
may import, so the phone that signs, Sideout's server that verifies and Purse that verifies
again run the same bytes through the same code. `@purse/sdk` would have been the closer
precedent (it holds the webhook signature for both sides), but Sideout's browser code may
mount the SDK from `PurseGate` only (phase 8), and the signing key lives in the score
sheet's path, not the gate's. The package description now names the contract.

### The consensus hash and the signature share one canonical scoreline

`canonicalizeScoreline` now writes its string through `canonicalJson(scorelineContent(…))`,
the same object the phone signs as `content`. Its output is byte-identical to the phase 7
form (`{"matchId":"…","sets":[[1,21,18],…]}`; the consensus test still pins the literal), so
no stored hash changes, and the two mechanisms can never disagree about what a scoreline is.

### `invalid_attestation` is a tenth error type, at 422

The spec's taxonomy (4.7) maps each sealed type to one status, and the brief asked for a
422. A new type was the honest way to get one: the request was well formed
(`invalid_request`, 400) and the contest in the right state (`invalid_state`, 409); what
failed was the proof. Every map over the sealed types (`API_ERROR_STATUS`, the console's
and the embed's titles, Sideout's `failure` helpers) carries it, and the contract fixtures
record it. A partner that branches on `type` sees a new value only when it sends an
attestation, which no partner did before.

### A key Purse does not hold is `unverified`, not refused

Purse refuses what it can prove wrong (a bad signature, a revoked key, a replay onto another
match, a timestamp from the future, a team the participant did not enter as). A key it has
never seen it cannot judge: the most likely cause is a mirror that has not landed (the
player checked in before linking a Purse account, or the mirror call failed), and refusing
the score would block settlement for a plumbing gap. Such a score is accepted as an
unattested score would be (decision D5, option A, is unchanged), the attestation is kept
verbatim as `unverified`, and the console shows the gap. `verified` therefore means exactly
one thing: Purse checked it against a key registered for that user through the partner's
authenticated session.

### The key id is the JWK thumbprint, never chosen

RFC 7638 over `{crv, kty, x, y}`. The phone, Sideout and Purse each derive it from the
public key, so a registration can never claim another key's id and the three copies agree
without trusting each other. It doubles as the outbox's and the UI's notion of "this phone".

### Check-in is a third step on the register screen; the team's status does not move

The product had a `checked_in` team status but nothing that set it beyond the seed. Device
registration is where the spec puts check-in, so the register screen grew a third step,
open from `registration_open` through `live` for a team that holds its place. Registering
a phone does not change `teams.status` (the seed's `checked_in` teams stay what they are,
and capacity, the draw and the field never depended on the difference); giving that status
a real meaning is a product change left to a later decision. A member registers their own
phone; both members may; a phone is registered per team, and the same key on another of
the player's teams is another row (Purse holds one registration per user and key, and a
revocation reaches Purse only when no live Sideout row holds the key for that user).

### Sideout refuses what Purse would; Purse never trusts that it did

Sideout checks the signature before the consensus sees a submission and stores only what
verified; a submission whose attestation fails is refused (422) rather than accepted
unsigned, so a stripped or replaced signature is never quietly downgraded. Purse repeats
every check it can against its own copy of the key. The signature timestamp is bounded at
Sideout to 72 hours old (the outbox window) and 5 minutes ahead; Purse bounds only the
future, since how long a partner keeps a queued reading is the partner's rule.

### What travels, and to whom it is attributed

Purse holds scores per user and knows nothing of teams beyond an optional `teamRef`, so
each team's attestation is attached to both of its players' running scores, attributed to
the signer's linked Purse user, and Purse checks the attesting user is an entered
participant. Only the standing submission whose hash is the agreed hash is forwarded: an
organizer's resolution carries none, and a team whose reading the organizer overrode sends
none. Purse cannot recompute a running score (a count of wins) from a scoreline; what it
verifies is that a registered device signed this scoreline for this `sourceRef`, and it
records the scoreline.

### No new environment variables

The clock-skew and age windows are constants documented in `docs/attestation.md`; nothing
about the feature needs configuring per environment, and the migrations carry the schema.

## Stretch: Sandbox self-serve decisions

Self-serve minting defaults on outside production and off in production. Firstmate
approved explicit `SANDBOX_SELF_SERVE=true` on the Purse Railway service for the public
demo; deployment is separate. `/health` reports the effective `sandboxSelfServe` value.

A visitor receives a fresh tenant, an operator-scoped sandbox secret key (credits and
close remain tenant-scoped), and a publishable key. Both expire after 24 hours; an
immutable tenant lease also enforces that deadline on any subsequently created key.
Minting takes `{}` and an address-scoped idempotency key. A replay returns the same tenant
with null keys, preserving the return-once rule without storing plaintext credentials.
Three live leases per address are enforced in PostgreSQL under an advisory lock; process
and address token buckets reuse the API limiter (ten per process / one per minute, three
per address / one per hour). Attempts including retries consume tokens.

The allowed append-only fallback is retirement: `db:purge` sets expired sandbox tenants
to `retired`, revokes keys and origins, disables endpoints and audits the retirement.
Tenant data and immutable lease receipts, including the minting address, remain. No new
DELETE grants are introduced. The immutable lease table receives SELECT/INSERT only;
existing column-level UPDATE grants support retirement. Managed tenants have no lease.
The console cannot reinstate a retired tenant, and lease expiry still blocks credentials
before the maintenance command runs.

Firstmate decided self-serve tenants cannot mutate outbound webhook endpoints or replay
deliveries: they receive `sandbox_webhooks_unavailable`. Reads remain possible. Existing
tenants keep their behavior. Fleet-wide destination validation and DNS/IP pinning are a
separate follow-up; this supersedes the initial suggestion to add that work here.

The API serves framework-free `/docs`, with manually applied design-token values and
examples bundled directly from the contract fixtures. A test compares its examples with
the registered v1 routes and its provider table with `docs/providers.md`. The browser
keeps keys in memory, permits requests only to this API's `/v1/` paths, refuses redirects,
and sends the existing embed routes their publishable key. Other routes use the secret
key, except public endpoints. Host-only internal reconciliation remains protected.
