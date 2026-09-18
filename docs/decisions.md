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
