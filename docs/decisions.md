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
table is append-only for the runtime. Phase 3's HTTP idempotency middleware can add the
response columns the spec lists or wrap these same services; either way partner keys are
per tenant, as the ledger's already are. The 30-day TTL purge is a phase 9 job running as
the owner. Request keys are at most 200 characters so the ledger keys derived from them
(`contest-entry:<key>`, `contest-withdraw:<key>`) fit the journal's 255.

### Money moved by settlement and void is keyed by the contest, not the request

A contest settles once and is voided once, so the settle entry's idempotency key is
`contest:<id>:settle` and each void reversal's is `contest:<id>:void:<participant>`. The
auto-settle path has no request key to derive from, and a contest-scoped key means a
second attempt by any route finds the entry rather than posting another. Entries and
withdrawals, which happen many times per contest, derive their ledger key from the
request's key.

### The phase 3 hooks left in place

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
also what lets it close an `operator_close` contest (spec 4.3 MUST) and drive `finish`,
`cancel` and `void`; a plain secret key acts as the `tenant` and is refused those with
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
any flow's. Consumed and expired tokens are kept a day for support and then purged.

### Two layers of idempotency, one table

Phase 2's `idempotency_keys` rows are the service layer's (the ids an operation produced,
committed with its effects). Phase 3 adds the HTTP layer the spec describes (endpoint,
request hash, response status and body) to the same table under a `scope` column that is
part of the primary key, so a partner's key is recorded twice, once per layer, and the
two never collide. The v1 middleware owns one database transaction per mutation: handlers
reach it as `c.get('db')`, every service transaction inside becomes a savepoint, and the
`http` row commits with the request's effects or not at all. A 2xx and every 4xx but 429
are stored, because a refusal is the answer to that request (Stripe's rule); a 5xx, a 429
and a failed commit store nothing and roll everything back, so the partner retries the same
key and the request is performed then. The stored body is jsonb, so a replay is the
original response as JSON (key order may differ). Keys are remembered for at least 30
days; `pnpm --filter @purse/api purge` removes older rows as the owner, after which a key
is fresh.

### A refusal for funds alone is `insufficient_funds`

Spec 4.5 lists `insufficient_balance` among the eligibility reasons and spec 4.7 lists
`insufficient_funds` among the error types. The evaluator reports the shortfall as a
reason (with `add_funds` as the action) and records it like every decision; the entry
route reports a decision whose only reason is the shortfall as `insufficient_funds` (402,
the money type a partner routes to funding), and any other refusal, including a shortfall
alongside a compliance reason, as `not_eligible` (403). Both carry `reasons[]`,
`requiredAction` and `rulesetVersion` in `detail`. The ledger's own non-negative wallet
guard stands behind the evaluator for the race it cannot see.

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
under-age user) never comes with "add funds".

### `rejected` is terminal for the user

The verification machine is `unstarted -> pending -> verified | rejected`, with
`verified -> pending` once `reverify_after` has passed (365 days after verification unless
the provider says otherwise). Spec 5.3 shows a refusal as a plain terminal explanation
with a support path and no retry button, so a rejected user cannot start again through the
API (`invalid_state` / `verification_rejected`); the database admits `rejected ->
unstarted` for the operator reset phase 5 builds. `pending` may be started again (a fresh
embed token for an abandoned iframe). The provider is called between two short
transactions, never under the row lock, and its answer is applied only if the user is still
`pending` when it arrives.

### Risk signals are surfaced, never enforced

The `RiskProvider` seam is consulted at entry alongside the evaluator. Its dev
implementation applies the spec 4.6 velocity and duplicate-account rules as signals
(`velocity_near_24h_limit`, `duplicate_identity_open`, `new_account_max_stake`, ...) and
answers `review`, never `deny`; a `review` becomes an `operator_flags` row (`risk_review`)
and the entry goes through. The evaluator enforces the limits themselves. Duplicate
identities (SHA-256 of the normalised name and the date of birth) are flagged per pair
within a tenant, once, and never auto-block; a user missing either part gets a fingerprint
of their own id so a cleared field cannot leave a stale match behind. The head-to-head
collusion signal is checked inside every head-to-head settlement for the pair it involved
and by `pnpm --filter @purse/api risk:scan` over a tenant; a meeting is a settled
head-to-head contest with a strict winner, and a qualifying pair is flagged once.

### Routes beyond the 4.7 list

Spec 4.7 lists `open` and `lock`; `start` (`in_progress`), `finish`
(`awaiting_settlement`) and `cancel` are the remaining plain transitions of spec 4.3 and
are mounted the same way, because scores are accepted only from `in_progress` and the
lifecycle must be reachable over HTTP. `GET /health` and `GET /internal/reconcile` answer
at the root (phase 0) and under `/v1` (the spec's base); neither takes an API key.

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

The per-key token bucket lives in process memory (`RATE_LIMIT_BURST`,
`RATE_LIMIT_PER_SECOND`), keyed by the presented key's visible prefix so it runs before
authentication and throttles guessing; a shared store for several replicas is a phase 9
concern. `/health` now reports the active ruleset version; the last reconcile result still
waits for phase 9's scheduled job.

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
