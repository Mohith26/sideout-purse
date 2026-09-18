# Sideout on Purse — System Spec

**Sideout** is a charity beach volleyball tournament product.
**Purse** is the competition-infrastructure platform it runs on, built from scratch.

Two services. One of them is the product. The other is the interesting part.

---

## 0. How to read this spec

This is a starting point, not a script. It is written to be opinionated enough that you
can start typing today, and loose enough that the architecture is still yours.

Three kinds of statement appear here:

- **MUST** — load-bearing. Changing it invalidates other parts of the spec. If you want
  to change one, read what depends on it first.
- **DEFAULT** — a recommendation with a stated reason. Override freely; the reason tells
  you what you are trading away.
- **DECISION** — genuinely yours. Section 3 collects these with options and consequences.
  Do not start phase 2 until you have answered D1 through D6.

Where something cannot be built honestly (real money movement, real identity
verification, licensed geolocation), the spec says so and specifies a **provider seam**
instead of pretending. Those seams are a feature: they are precisely where a real
platform's licensed moat sits, and being able to point at them and say "this is where
GeoComply plugs in, and here is the interface it would satisfy" is stronger than a fake
implementation.

---

## 1. The thesis

Anyone can integrate against a vendor SDK. The hard, interesting work is being the
vendor: holding a correct ledger, resolving contests deterministically, settling money
without leaking a cent, deciding who is eligible to play, and exposing all of it to a
partner application through a boundary you cannot cheat across.

So Purse implements the platform architecture end to end:

1. A **double-entry ledger** that is immutable, idempotent, and reconcilable, where the
   global balance provably sums to zero at all times.
2. A **contest engine** with an explicit lifecycle, escrowed entries, and pluggable
   formats.
3. A **deterministic settlement engine** where the same inputs always produce the same
   payouts, the payouts always sum exactly to the escrowed pool, and rounding dust is
   allocated by a stated rule rather than lost.
4. An **eligibility and compliance engine** that evaluates declarative rules into a
   typed decision, mirroring the sealed error taxonomy a real platform exposes.
5. An **embeddable SDK** delivered as a cross-origin iframe with a typed postMessage
   protocol, so identity and wallet UI live on the platform's origin and never in the
   partner's DOM.
6. **Signed, retrying webhooks** with a delivery log and a dead-letter queue.
7. An **operator console** where a human closes contests behind a frozen preview.

And Sideout consumes all of it as a real third-party client would: over the network,
through the published SDK and API, with its own database that Purse cannot see.

That boundary is the entire point. If the two services share a database, this is one
application with extra folders. If they do not, it is a platform.

### What is deliberately not real

State this plainly in the README. It is a strength, not a caveat.

- **No real money.** Purse's contest currency is closed-loop: `POINTS` (free entry) and
  `CREDIT` (sponsor-funded, redeemable for goods). No cash prizes, no withdrawals to a
  bank, no peer-to-peer wagering. The ledger is real; the asset is not legal tender.
- **No real identity verification.** The KYC state machine is real. The verification
  itself is a provider interface with a deterministic dev implementation.
- **No licensed geolocation.** Same pattern: real eligibility rules, a `GeoProvider`
  seam, an IP-plus-override dev implementation.
- **Charity donations are the only real dollars**, they go through Stripe, and they
  never enter the contest ledger. See D3 and section 4.2.6.

---

## 2. System overview

```
┌────────────────────────────────────────────────────────────────┐
│ sideout.app                      Sideout (Next.js)            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Sideout UI: events, pools, bracket, score entry, impact  │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │ <iframe src="purse.app/embed/...">                 │  │  │
│  │  │   Purse-hosted flows: sign-in, identity, wallet,   │  │  │
│  │  │   entry confirm, rewards.  postMessage bridge.      │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│  Sideout server: tournaments, teams, score consensus           │
│  Sideout DB (Postgres)  ← Purse has no access                  │
└───────────────┬────────────────────────────────────────────────┘
                │  HTTPS, secret key, server-to-server only
                │  webhooks back, HMAC-signed
┌───────────────▼────────────────────────────────────────────────┐
│ purse.app                        Purse (Hono / Node)          │
│  API · contest engine · ledger · settlement · eligibility      │
│  embed app (iframe UI) · operator console · webhook dispatcher │
│  Purse DB (Postgres)   ← Sideout has no access                 │
└────────────────────────────────────────────────────────────────┘
```

### The four rules that make this a platform

1. **MUST: separate databases.** No shared connection string, no cross-schema query, no
   foreign key across the boundary. Sideout references Purse objects by opaque id only.
2. **MUST: the secret key never reaches a browser.** Purse issues a `sk_` secret key
   (server-to-server) and a `pk_` publishable key (safe for the client, used only to
   bootstrap the iframe). A test greps the built client bundle for `sk_`.
3. **MUST: Sideout owns the outcome, Purse owns the settlement.** Sideout decides what
   the score is, using its own consensus rules. Purse decides what that score pays, and
   refuses to settle a contest that a human has not closed.
4. **MUST: every Purse mutation is idempotent.** Every write takes an idempotency key.
   Replaying it returns the original result and creates nothing new.

---

## 3. Decision points

Answer D1 through D6 before writing schema. The rest can wait until their phase.

### D1 — Repository layout
- **A. pnpm monorepo, two apps, shared packages.** One `git push`, shared types via a
  package, easy local orchestration. Risk: it is tempting to import across the boundary.
  Mitigate with an ESLint `no-restricted-imports` rule that forbids Sideout importing
  anything from Purse except `@purse/sdk` and `@purse/types`.
- **B. Two separate repositories.** The boundary is physically impossible to violate.
  Costs you a versioned SDK publish step and a worse local dev loop.
- **DEFAULT: A**, with the lint rule. You get the demo velocity and the boundary is
  still enforced, just by tooling rather than physics. Say so in the README.

### D2 — Boundary enforcement
- **A. Two Postgres databases, two connection strings.** Real isolation.
- **B. One Postgres instance, two databases.** Cheaper to host, still isolated.
- **C. One database, two schemas.** Tempting and wrong; a single transaction could span
  both and the platform claim collapses.
- **DEFAULT: B locally and in production.** One managed Postgres, two logical databases,
  two distinct connection strings that are never both loaded into the same process.

### D3 — Currency and legal posture

This is the most consequential decision in the document.

- **A. Closed-loop only.** `POINTS` for free entry, `CREDIT` funded by sponsors and
  redeemable for goods. Charity donations are separate real dollars via Stripe that
  never touch contest escrow. No cash out.
- **B. Closed-loop plus cash-equivalent payouts.** Gift cards or store credit with real
  value flowing out. Drags in money-transmission and prize-promotion questions.
- **C. Real-money peer-to-peer.** Requires licensing you do not have. Not an option.
- **DEFAULT: A, and treat it as MUST.** Everything downstream assumes it. The ledger,
  the escrow model, and the settlement math are all identical to a real-money system, so
  nothing about the engineering is diminished — you just cannot be wrong in a way that
  matters legally. Note in the README that swapping the asset type to real currency is
  a licensing problem, not an architecture problem.

### D4 — Ledger representation
- **A. Immutable double-entry journal.** Entries with balanced debit and credit lines,
  balances derived by aggregation, corrections by reversing entry.
- **B. Balance column with a transaction log.** Simpler, faster reads, and impossible to
  prove correct. Drift is undetectable.
- **DEFAULT: A, and treat it as MUST.** This is the single most impressive component in
  the build and the one an engineer will check first. Section 4.2 specifies it fully.

### D5 — Score trust model
- **A. Dual-team confirmation with organizer arbitration.** Both teams submit
  independently; agreement by hash; mismatch goes to a dispute queue.
- **B. Organizer-authoritative.** One trusted scorekeeper enters everything. Simpler,
  but the interesting problem disappears.
- **C. Dual confirmation plus a signed attestation** from the submitting device.
- **DEFAULT: A.** It is the honest model for a self-reported sport, it produces a real
  state machine, and it is the thing to talk about in an interview. C is a stretch goal
  in section 12.

### D6 — Settlement trigger
- **A. Operator close only.** A human closes the contest behind a frozen preview.
- **B. Auto-settle when all results are final.**
- **C. Both, configurable per contest.**
- **DEFAULT: C, defaulting to A.** Build both paths because the difference is
  interesting and testable, but ship every Sideout tournament on operator close. A
  contest carries a `settlement_policy` column.

### D7 — SDK delivery
- **A. Cross-origin iframe plus typed postMessage.** Identity and wallet UI render on
  the Purse origin. This is what real platforms do, because it keeps the partner's DOM
  away from credentials and session.
- **B. npm React component library.** Easier, but the partner app now hosts
  identity UI and shares an origin with wallet state.
- **C. REST only, partner builds all UI.**
- **DEFAULT: A**, with a thin `@purse/sdk` npm wrapper that manages the iframe, the
  handshake, and the message types. Support C as a headless mode for reads.

### D8 — Identity ownership
- **A. Purse owns identity.** Sideout has a shadow user row linked by `external_id`.
  Mirrors how a real platform works.
- **B. Sideout owns identity, Purse trusts a signed assertion (JWT).**
- **DEFAULT: A for the wallet-bearing identity, B for the app session.** Sideout
  authenticates its own users however it likes, then links them to a Purse user via
  `external_id`. Two identities, one link table, which is exactly the real-world shape.

### D9 — Eligibility rules representation
- **A. Declarative JSON ruleset**, versioned, evaluated by a pure function.
- **B. Hardcoded TypeScript predicates.**
- **DEFAULT: A.** A versioned ruleset means you can show an auditor which rules were in
  force when a decision was made, and you can unit-test the evaluator against a table
  of cases. Store the ruleset version on every decision you persist.

### D10 — Prize structure representation
- **A. Declarative structure** (winner-take-all, placement table, percentage split,
  guaranteed minimum) compiled to payouts by a pure function.
- **B. Hand-entered payout amounts per contest.**
- **DEFAULT: A.** This is where the property tests live and where the rounding rule
  earns its keep.

### D11 — Real-time transport
- **A. Server-Sent Events** for live scores and standings.
- **B. Polling with `stale-while-revalidate`.**
- **C. WebSockets.**
- **DEFAULT: B for v1, A in polish.** Polling at 5s is invisible to a demo audience and
  removes a class of deployment problems. SSE is a contained upgrade later.

### D12 — Hosting
See section 10. **DEFAULT: Railway, two services, one Postgres with two databases,
custom subdomains on a personal domain.** Keep this off any employer infrastructure.

---

## 4. Purse — the platform

Stack: Node 22, TypeScript strict, **Hono** for the API, **Drizzle** for schema and
migrations, **Postgres 16**, **Zod** at every boundary, **Vitest** including
property-based tests via `fast-check`. The operator console and the embed app are small
Next.js apps in the same workspace.

### 4.1 Domain model

Ids are UUID v7 strings with typed prefixes (`usr_`, `cnt_`, `acct_`, `ent_`, `txn_`).
All timestamps are `timestamptz`. All amounts are `bigint` minor units with an explicit
asset column. **No floats anywhere in the money path.**

**Tenancy**
- `tenants` — `id`, `name`, `status`. Sideout is one row. Real from day one because
  retrofitting tenancy is miserable.
- `api_keys` — `id`, `tenant_id`, `kind` (`secret`|`publishable`), `key_hash` (argon2),
  `key_prefix` (shown in UI), `environment` (`sandbox`|`live`), `last_used_at`,
  `revoked_at`. **Store only the hash.**
- `webhook_endpoints` — `id`, `tenant_id`, `url`, `signing_secret`, `subscribed_events`,
  `status`, `created_at`.

**Identity**
- `users` — `id`, `tenant_id`, `external_id` (unique per tenant — the partner's opaque
  id), `display_name`, `phone_e164`, `date_of_birth`, `created_at`.
- `user_verification` — `user_id`, `state` (`unstarted`|`pending`|`verified`|`rejected`),
  `provider`, `provider_ref`, `verified_at`, `reverify_after`. No identity documents,
  ever.
- `user_restrictions` — `id`, `user_id`, `kind` (`self_exclusion`|`cool_off`|
  `platform_block`|`velocity_lock`), `reason`, `starts_at`, `ends_at`, `created_by`.
- `user_locations` — `user_id`, `region_code`, `source` (`ip`|`declared`|`provider`),
  `resolved_at`, `confidence`.

**Contests**
- `contests` — `id`, `tenant_id`, `external_id` (unique per tenant),
  `kind` (`tournament`|`head_to_head`|`pool`),
  `title`, `asset` (`POINTS`|`CREDIT`), `entry_amount`, `max_participants`,
  `prize_structure` (jsonb, see 4.4), `settlement_policy` (`operator_close`|`auto`),
  `eligibility_ruleset_version`, `state` (see 4.3), `opens_at`, `locks_at`,
  `escrow_account_id`, `created_at`, `settled_at`.
- `contest_participants` — `id`, `contest_id`, `user_id`, `team_ref` (opaque partner
  string, nullable), `joined_at`, `entry_journal_entry_id`, `state`
  (`entered`|`withdrawn`|`disqualified`).
- `contest_scores` — `id`, `contest_id`, `user_id`, `score` (numeric),
  `attempt_finished` boolean, `submitted_at`, `source_ref`, `superseded_by`.
  Append-only.
- `contest_results` — `id`, `contest_id`, `user_id`, `placement`, `score`,
  `payout_amount`, `payout_journal_entry_id`, `computed_at`. Written once at settlement.

**Ledger** — see 4.2.

**Plumbing**
- `idempotency_keys` — `key` (pk), `tenant_id`, `endpoint`, `request_hash`,
  `response_status`, `response_body`, `created_at`. TTL 30 days.
- `webhook_deliveries` — `id`, `endpoint_id`, `event_id`, `event_type`, `payload`,
  `attempt`, `status` (`pending`|`delivered`|`failed`|`dead`), `response_status`,
  `next_attempt_at`, `delivered_at`.
- `audit_log` — every state transition, with actor kind, subject, before and after.

### 4.2 The ledger

This section is MUST in its entirety. It is the part of the build that proves you can
be trusted with a settlement system.

#### 4.2.1 Accounts

`accounts` — `id`, `tenant_id`, `kind`, `owner_ref` (nullable), `asset`, `normal_side`
(`debit`|`credit`), `status`, `created_at`. Unique on
(`tenant_id`,`kind`,`owner_ref`,`asset`).

| Kind | Normal side | Meaning |
|---|---|---|
| `user_wallet` | credit | a player's spendable balance |
| `contest_escrow` | credit | funds held for one specific contest |
| `sponsor_funding` | debit | source of sponsor-provided prize value |
| `promo_liability` | credit | points the platform has issued and owes |
| `platform_fee` | credit | rake, if any; zero in v1 but modeled |
| `external_settlement` | debit | the boundary account for redemptions leaving the system |

Every account has exactly one asset. Cross-asset movement is a pair of entries through
an explicit exchange account, never a single mixed entry.

#### 4.2.2 Journal

`journal_entries` — `id`, `tenant_id`, `kind`, `description`, `idempotency_key`
(unique, not null), `contest_id` (nullable), `reverses_entry_id` (nullable),
`created_at`, `posted_at`.

`journal_lines` — `id`, `entry_id`, `account_id`, `direction` (`debit`|`credit`),
`amount` (bigint, **strictly positive**), `asset`, `sequence`.

Rules, all enforced:

1. An entry MUST have at least two lines.
2. For each entry and each asset, `sum(debit) = sum(credit)`. Checked in the same
   transaction that inserts the lines, before commit.
3. All lines in an entry MUST share one asset in v1.
4. `amount` MUST be positive. Direction carries the sign.
5. Lines and entries are **append-only**. No `UPDATE`, no `DELETE`. Revoke `UPDATE` and
   `DELETE` on both tables from the application role at the database level so this is
   not merely a convention.
6. A mistake is corrected by posting a reversing entry with `reverses_entry_id` set,
   never by editing history.
7. `idempotency_key` is unique and required. Posting the same key twice returns the
   original entry.

#### 4.2.3 Balances

Balances are **derived**: for an account, the signed sum of its lines relative to its
`normal_side`. Provide `balanceOf(accountId, asOf?)` and make point-in-time queries work
by simply bounding on `posted_at` — this falls out of an append-only design for free and
is worth calling out in the README.

`account_balance_snapshots` may be added for performance: `account_id`,
`as_of_entry_id`, `balance`, `computed_at`. If you add it, a scheduled job MUST verify
every snapshot equals the derived value and alarm on any divergence. A cache that can
silently disagree with the journal is worse than no cache.

#### 4.2.4 Invariants

Implement these as a `reconcile()` routine, run in CI, on a schedule in production, and
exposed at `GET /internal/reconcile`:

- **I1.** For every asset, the sum of all debits equals the sum of all credits across
  the entire journal. The system nets to zero.
- **I2.** Every entry independently balances.
- **I3.** No `user_wallet` balance is negative.
- **I4.** For every contest in state `settled`, its escrow balance is exactly zero.
- **I5.** For every `settled` contest, the sum of `contest_results.payout_amount`
  equals the total escrowed for that contest.
- **I6.** Every snapshot equals its derived balance.
- **I7.** Every `contest_participants.entry_journal_entry_id` points to an entry that
  debits that user's wallet and credits that contest's escrow, for the contest's asset
  and the contest's entry amount.

A failing invariant is a hard alarm, not a warning. `reconcile()` returning anything but
clean MUST fail the build.

#### 4.2.5 Standard flows

```
Issue promo points to a user
  debit  promo_liability        1000 POINTS
  credit user_wallet:usr_x      1000 POINTS

Enter a contest
  debit  user_wallet:usr_x       100 POINTS
  credit contest_escrow:cnt_y    100 POINTS

Refund a withdrawal before lock
  debit  contest_escrow:cnt_y    100 POINTS
  credit user_wallet:usr_x       100 POINTS

Settle a contest (one entry, many lines, must balance)
  debit  contest_escrow:cnt_y    600 POINTS
  credit user_wallet:usr_a       300 POINTS
  credit user_wallet:usr_b       200 POINTS
  credit user_wallet:usr_c       100 POINTS

Void a contest (reversing entry per entrant)
  debit  contest_escrow:cnt_y    100 POINTS
  credit user_wallet:usr_x       100 POINTS
```

#### 4.2.6 The charity boundary

Charity donations are real dollars and MUST NOT appear in the Purse ledger at all. They
live in Sideout, in a `donations` table, processed by Stripe, reconciled against Stripe's
own reporting. There is no account of asset `USD` in Purse in v1, and no code path can
move value between a donation and a contest. Write a test that asserts no Purse account
exists with asset `USD`. That test is the compliance boundary made executable.

### 4.3 Contest lifecycle

```
draft ──► open ──► locked ──► in_progress ──► awaiting_settlement ──► settling ──► settled
  │         │         │            │                   │
  └─────────┴─────────┴────────────┴───────────────────┴──► cancelled (before any entry)
                      └────────────┴───────────────────┴──► voided (entries refunded)
```

- `draft` — editable; no entries permitted.
- `open` — entries accepted; eligibility evaluated per entry; escrow accumulates.
- `locked` — no new entries; `locks_at` reached or operator locked it.
- `in_progress` — scores being accepted.
- `awaiting_settlement` — all expected results present; nothing has paid out.
- `settling` — a short-lived state held under a row lock while the settlement
  transaction runs. Prevents double settlement under concurrency.
- `settled` — terminal; results and payouts written; escrow zero.
- `voided` — terminal; every entry refunded by reversing entries; escrow zero.

MUST: transitions are performed by a single `transition(contestId, to, actor)` function
that validates the source state, takes `SELECT ... FOR UPDATE` on the contest row, and
writes `audit_log`. No route mutates `state` directly.

MUST: a contest with `settlement_policy = operator_close` cannot leave
`awaiting_settlement` without an operator actor. Assert the actor kind in the transition.

### 4.4 Settlement engine

A pure function. No database access, no clock, no randomness.

```ts
settle(input: {
  asset: Asset;
  escrowTotal: bigint;
  entries: Array<{ userId: string; score: number | null }>;
  prizeStructure: PrizeStructure;
  tieBreak: TieBreakRule;
}): Array<{ userId: string; placement: number; payout: bigint }>
```

`PrizeStructure` variants to support:

- `winner_take_all`
- `placement_table` — explicit amounts or percentages per placement
- `percentage_split` — e.g. `[50, 30, 20]`
- `top_n_equal` — split evenly among the top N
- `guaranteed_minimum` — a floor per placement, with the remainder distributed by
  percentage

Hard requirements:

1. **Conservation.** `sum(payout) === escrowTotal`, exactly, always. This is a property
   test over generated inputs, not an example test.
2. **Determinism.** Same input, same output, byte for byte. No `Math.random`, no
   `Date.now`, no map iteration order dependence.
3. **Rounding is specified, not incidental.** Percentage splits produce fractional minor
   units. Compute each share with floor division, then distribute the remainder one
   minor unit at a time in descending placement order, breaking further ties by
   ascending `userId`. Document this rule in the code and the README. A percentage split
   of 100 points three ways MUST produce 34/33/33 and never 33/33/33 with a lost unit.
4. **Ties are explicit.** `TieBreakRule` is one of `split_evenly`,
   `higher_seed_wins`, `earliest_submission_wins`. `split_evenly` shares the combined
   prize for the tied placements and then applies the same remainder rule.
5. **Unscored entries place last** and receive nothing, unless the structure defines a
   participation floor.
6. **Zero-entry and single-entry contests** are defined: a single entrant in a
   `winner_take_all` receives the whole escrow, which is their own entry back.

Property tests MUST cover: conservation, non-negativity, placement monotonicity
(a strictly higher score never receives strictly less), and determinism under input
permutation.

### 4.5 Eligibility and compliance engine

A pure evaluator over a versioned ruleset.

```ts
evaluate(input: {
  user: { dateOfBirth: string; verificationState: VerificationState;
          restrictions: Restriction[]; region: string | null };
  contest: { asset: Asset; entryAmount: bigint; kind: ContestKind };
  wallet: { balance: bigint };
  velocity: { enteredLast24h: bigint; enteredLast7d: bigint };
  ruleset: Ruleset;
}): EligibilityDecision
```

```ts
type EligibilityDecision =
  | { allowed: true; rulesetVersion: string }
  | { allowed: false; rulesetVersion: string;
      reasons: Reason[]; requiredAction?: RequiredAction };

type Reason =
  | 'under_minimum_age' | 'region_not_permitted' | 'identity_unverified'
  | 'identity_rejected' | 'self_excluded' | 'cooling_off' | 'platform_blocked'
  | 'insufficient_balance' | 'stake_limit_exceeded' | 'velocity_limit_exceeded'
  | 'region_unknown' | 'contest_not_open' | 'contest_full';

type RequiredAction =
  | 'complete_identity' | 'provide_demographics'
  | 'add_funds' | 'confirm_location';
```

**MUST: mirror a real platform's sealed taxonomy.** The SDK surfaces exactly these
variants and the partner branches on the variant, never on a message string. Message
copy is a presentation concern that changes; the variant is the contract.

Ruleset shape, versioned and stored:

```json
{
  "version": "2026.09.1",
  "minimumAge": { "default": 18, "byRegion": { "US-NE": 19, "US-AL": 19,
                                               "US-IA": 21, "US-MA": 21 } },
  "permittedRegions": { "POINTS": "ALL", "CREDIT": ["US-TX","US-NC","US-CA"] },
  "stakeLimits": { "perContest": 50000, "per24h": 200000, "per7d": 1000000 },
  "requireVerificationAbove": { "POINTS": null, "CREDIT": 0 },
  "requireKnownRegion": { "POINTS": false, "CREDIT": true }
}
```

Note the shape deliberately mirrors the real regulatory asymmetry: a free-to-play asset
is permitted everywhere with no verification, while a value-bearing asset is
region-gated and verification-gated. Getting that asymmetry right is the compliance
insight worth demonstrating.

Provider seams, each an interface with a dev implementation:

- `IdentityProvider.verify(user) → VerificationResult` — dev implementation verifies
  deterministically from a seeded allow/deny list. This is where Persona or Socure
  would plug in.
- `GeoProvider.resolve(request) → { region, confidence, source }` — dev implementation
  reads a declared region with an IP fallback. This is where GeoComply would plug in.
- `RiskProvider.assess(transaction) → { decision, signals }` — dev implementation
  applies the velocity and duplicate-account rules below. This is where Sardine would
  plug in.

Document each seam in the README with the real vendor it stands in for. That table is
one of the most credible things in the whole project.

### 4.6 Risk controls

Modest but real, and all testable:

- **One wallet per user per asset.** Enforced by unique constraint.
- **Duplicate-identity detection.** Hash `(normalized_name, date_of_birth)` and flag
  collisions across users for operator review rather than auto-blocking.
- **Velocity limits.** Rolling 24h and 7d entry totals, enforced in the eligibility
  evaluator, computed from the journal rather than a counter column.
- **Self-exclusion and cool-off** honored before every entry, and irreversible by the
  user for the duration.
- **Collusion signal.** For head-to-head contests, flag pairs who have faced each other
  more than N times with a one-sided result distribution. Surface to the operator; do
  not act automatically.

### 4.7 Public API

Base `https://purse.app/v1`. Secret key in `Authorization: Bearer sk_...`. Every
mutation requires `Idempotency-Key`. Responses are
`{ data }` or `{ error: { type, code, message, detail? } }`.

```
POST   /users                        create or upsert by external_id
GET    /users/:id
POST   /users/:id/verification       start identity flow (returns embed token)
GET    /users/:id/wallet             balances by asset
POST   /users/:id/credits            issue promo points (operator scope only)

POST   /contests                     create (draft)
GET    /contests/:id
POST   /contests/:id/open
POST   /contests/:id/lock
POST   /contests/:id/entries         join; evaluates eligibility, escrows entry
DELETE /contests/:id/entries/:userId withdraw before lock; refunds
POST   /contests/:id/scores          submit scores (batch)
POST   /contests/:id/close           operator close → settles behind preview
GET    /contests/:id/preview         frozen settlement preview, no side effects
POST   /contests/:id/void            refund all entries
GET    /contests/:id/results

POST   /embed/tokens                 short-lived token for an iframe session
GET    /internal/reconcile           invariant report
GET    /health                       sha, migrations, ruleset version, SDK version
```

**MUST: `GET /contests/:id/preview` and the settlement executed by `close` are computed
by the same pure function.** The preview is not an estimate. Return a hash of the
computed payout set in the preview, require that hash as a parameter to `close`, and
reject the close if the recomputed hash differs. That single mechanism makes
"frozen preview" a guarantee rather than a UI affordance, and it is the detail most
worth being proud of.

Error types, mirroring a real sealed taxonomy:
`invalid_request` · `authentication_error` · `permission_error` ·
`not_eligible` (carries `reasons[]` and `requiredAction`) · `insufficient_funds` ·
`invalid_state` · `conflict` · `rate_limited` · `internal_error`.

### 4.8 SDK and the iframe protocol

`@purse/sdk`, framework-agnostic, ~400 lines.

```ts
const purse = await Purse.init({
  publishableKey: 'pk_...',
  tenantId: 'tnt_...',
  theme: { accent: '#D7FF3E', surface: '#101216', radius: 10, font: 'Instrument Sans' },
});

await purse.mount('#purse-slot', { flow: 'identity', embedToken });
const state = await purse.getUserState();
purse.on('flow:complete', ({ flow, result }) => {});
purse.on('error', (e) => {});      // sealed variants from 4.5
```

Protocol requirements, all MUST:

1. The iframe is served from the Purse origin. Session cookies for identity live there
   and are `SameSite=None; Secure; HttpOnly; Partitioned`.
2. Every `postMessage` specifies an exact target origin. Never `'*'`.
3. The receiver validates `event.origin` against an allowlist **and** validates the
   message against a Zod schema. Anything failing either check is dropped silently and
   counted.
4. A handshake establishes a nonce; every subsequent message carries it. Messages with a
   missing or stale nonce are dropped.
5. Embed tokens are single-use, scoped to one user and one flow, and expire in 5
   minutes.
6. The parent can request a resize; the iframe reports its content height. No scrollbars
   inside the frame.
7. The SDK exposes a headless mode that skips the iframe for pure reads.
8. Theming is passed at init and applied by the embed app via CSS custom properties, so
   the Purse flows look native inside Sideout.

Write the message protocol as a discriminated union in `@purse/types` and share it
across both sides. Version it with a `v` field from the first commit.

### 4.9 Webhooks

Outbound from Purse. Events:

```
user.verification.updated      contest.locked
contest.opened                 contest.settled
contest.entry.created          contest.voided
contest.entry.withdrawn        wallet.balance.changed
```

MUST:
- Signature header `Purse-Signature: t=<unix>,v1=<hex>` where `v1` is
  HMAC-SHA256 over `"{t}.{rawBody}"` using the endpoint's signing secret. Compare in
  constant time. Reject timestamps outside a 5-minute window to prevent replay.
- Retry on non-2xx with exponential backoff and jitter: 8 attempts over roughly 24
  hours, then `dead`.
- Persist every attempt in `webhook_deliveries`.
- Operator console can inspect and manually replay any delivery.
- Payloads carry an `id`; receivers dedupe on it.

Because you own both sides, build the receiver to be genuinely idempotent and then
**demo a real failure**: take Sideout's receiver down, settle a contest, show the
deliveries queuing and retrying, bring it back, show it drain. That demo is worth more
than any amount of description.

### 4.10 Operator console

A separate Next.js app at `console.purse.app`, behind its own auth, using the same
design system with denser layout.

- Tenants, API keys (create, reveal once, revoke), webhook endpoints and delivery log.
- Contest browser with state, escrow balance, entrant list.
- **Close flow:** frozen preview showing placements and payouts with the payout hash,
  then an explicit confirm. This is the two-step commit from 4.7.
- Dispute and duplicate-identity review queues.
- **Ledger explorer:** account tree, journal entry drill-down showing balanced lines,
  point-in-time balance query, and a live invariant panel that runs `reconcile()`.
- Ruleset editor with version history and a "what would this decide" tester that runs
  the evaluator against a sample user without persisting.

The ledger explorer and the invariant panel are the two screens to show an engineer.
Build them properly.

---

## 5. Sideout — the product

Stack: Next.js 15 App Router, TypeScript strict, Tailwind, Drizzle, Postgres, its own
database. Consumes Purse over HTTPS only.

### 5.1 Domain model

Only what Purse does not own.

- `users` — local account, `purse_external_id` (the link), display name, avatar.
- `charities`, `sponsors`, `donations` (Stripe; never in Purse).
- `tournaments` — event metadata, format, division, beneficiary, goal,
  `purse_contest_id`, `purse_external_id`, status mirror.
- `teams`, `team_members` — pairs.
- `pools`, `pool_teams`, `matches`, `sets` — the bracket and pool structure. Purse knows
  nothing about brackets; it only knows a contest and per-user scores. Tournament
  structure is Sideout's domain, which is exactly the right split.
- `score_submissions`, `match_consensus` — the trust boundary, section 5.2.
- `purse_calls` — an audit of every request and response to Purse, with the idempotency
  key, for the `/admin/purse` page.

### 5.2 Score consensus

Beach volleyball scores come from a phone on the sand, so a single submitted number must
never be enough to move value.

```
awaiting_first
  └─ one team submits ──► awaiting_second
        ├─ other team submits matching hash ──► agreed
        └─ other team submits different hash ──► disputed
disputed ──► organizer resolves ──► agreed
agreed ──► pushed_to_purse ──► confirmed
```

MUST:
1. Scorelines are canonicalized (ordered sets, normalized orientation) and hashed;
   agreement is hash equality.
2. The two submissions MUST come from users on different teams. Enforced in the query.
3. **Plausibility validation before anything is pushed.** Beach volleyball gives real
   constraints: sets to 21, third set to 15, win by two, best-of-1 or best-of-3. An
   illegal scoreline is rejected at submission with a specific message and never reaches
   Purse.
4. Reaching `agreed` mints one idempotency key, reused for every Purse attempt.
5. Only `agreed` may push to Purse.
6. Tournament close is blocked while any match is `disputed` or unconfirmed, and the UI
   names the blocker.
7. Every transition writes to Sideout's audit log.

### 5.3 Screens

Mobile-first at 390px, then 768, then 1280. Installable PWA. Offline read of your own
pool, and a queued score submission that survives reload and syncs on reconnect —
players are on a beach with bad signal, and this is the detail that separates a product
from a demo.

1. **Home** — live-first. If an event is in progress, a live match strip is the top of
   the screen. Then featured event, upcoming, past events with what each raised. Not a
   marketing hero; the app opens into the state of play.
2. **Tournament** — sticky header with beneficiary and live state. Tabs: Overview,
   Bracket (SVG, pan-zoom, animated advancement), Standings (point-differential
   tiebreaks, animated reorder), Impact (raised vs goal, donors, sponsors).
3. **Match** — the score sheet. Bottom sheet, thumb-reachable, one row per set, large
   steppers for wet sandy hands, live legality validation as you type. First submitter
   sees "waiting on {opponent}" with an explanation. Second submitter either confirms or
   lands in a neutral side-by-side disagreement view with the differing set highlighted.
   No blame language.
4. **Register** — create team, invite partner by phone, make the charitable donation
   (Stripe), then a visually distinct Purse flow for contest entry. The separation is
   deliberate so nobody thinks their donation is a stake.
5. **Profile** — verification state as a calm status row, wallet chip, rewards, history,
   responsible-play links. A `not_allowed` decision gets a plain terminal explanation
   and a support path, with no retry button.
6. **Organizer console** — event builder with live draw preview, court-by-court live
   board, dispute queue as the primary alert, and close-tournament as a two-step confirm
   against Purse's frozen preview and payout hash.
7. **`/admin/purse`** — every row of `purse_calls` with full request and response. Open
   this when an engineer asks how the integration behaves.

---

## 6. Design system

Shared package `@sideout/ui`, consumed by Sideout, the Purse embed app, and the operator
console, so Purse's flows look native inside Sideout.

Reference points: **Offsuit** for restraint and legibility — their stated position is
that poker "doesn't have to look and feel like a scam," and the result is calm, dark,
generously spaced, with elegant stat display and no casino ornamentation. **Five Iron
Golf** for urban sports attitude — near-black, bold type, one confident accent,
nightlife rather than country club. The synthesis is **premium dark sports-tech**: closer
to a well-made performance or trading app than a gaming skin.

### 6.1 Color

Dark only. Do not build a half-finished light theme.

```css
--bg-base:        #08090B;
--bg-raised:      #101216;
--bg-overlay:     #171A1F;
--bg-inset:       #050607;
--border-subtle:  #22262D;
--border-strong:  #323843;
--text-primary:   #F4F5F7;
--text-secondary: #9BA3AF;
--text-tertiary:  #646C79;
--volt:           #D7FF3E;   /* primary action, brand */
--volt-dim:       #A8C82F;
--on-volt:        #08090B;   /* dark text on volt, never white */
--ember:          #FF6B3D;   /* charity and impact only, never a button */
--surf:           #35D6C3;   /* live, agreed, positive delta */
--fault:          #FF4D4D;   /* error, dispute, failed invariant */
```

Discipline: one primary accent. Two volt buttons on a screen means one is wrong.
Elevation comes from background lightness plus a hairline border, not drop shadows.
Shadows only on genuinely floating overlays. Color is never the sole carrier of meaning.

### 6.2 Type

- **Display:** Archivo Expanded, 600–800, uppercase for headings and scores, tracking
  `-0.01em` to `-0.02em`. Broad and athletic, not condensed.
- **UI:** Instrument Sans, 400/500/600.
- **Any changing number** gets `font-variant-numeric: tabular-nums` so digits do not
  jitter. Non-negotiable for scores, timers, standings, balances.

```
display-xl  clamp(2.75rem, 6vw, 4.5rem)   live score
display-l   clamp(2rem, 4vw, 3rem)        page titles
heading     1.5rem / 600
subheading  1.125rem / 600
body        0.9375rem / 400, line-height 1.55
label       0.8125rem / 500, uppercase, tracking 0.06em
```

No centered long-form text. Nothing below 15px in primary content.

### 6.3 Space, radius, motion

8px grid, 4px half-step. Restrained radii, because oversized corners are the fastest
route to looking generated: `4px` chips, `6px` inputs and buttons, `10px` cards,
`14px` sheets, `999px` pills.

```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.30, 1);
--d-micro: 120ms;  --d-base: 220ms;  --d-enter: 420ms;  --d-draw: 700ms;
```

Six required transitions: score count-up (tabular, stable width); standings FLIP reorder
with a brief `--surf` rank-delta flash (write a ~40-line FLIP helper, no dependency);
bracket advancement via SVG `stroke-dashoffset`; consensus confirm as one decisive
`--surf` check, one beat not a celebration; sheet translateY with 8px backdrop blur;
2s breathing dot on live indicators only. All wrapped in
`@media (prefers-reduced-motion: reduce)` and reduced to opacity.

### 6.4 Accessibility

WCAG AA across all text tiers, verified for `--volt` on `--bg-base`. Full keyboard
operability including the bracket. 2px `--volt` focus ring at 2px offset. Real semantic
headings. `aria-live="polite"` on score and standings updates. 44×44px minimum targets,
larger for set steppers.

---

## 7. Anti-patterns — banned

- Indigo-to-violet or purple-to-blue gradients anywhere.
- Emoji as iconography. One icon set, 1.5px stroke.
- Glassmorphism as a general surface treatment. Backdrop blur only on sheet backdrops.
- Uniform `rounded-2xl` / `rounded-3xl`. Follow 6.3.
- A marketing hero with a centered headline and three equal feature cards.
- Visible stock component-library defaults. If a screen looks like untouched shadcn, it
  is not finished.
- Decorative full-bleed beach photography. One editorial image maximum, carrying
  information.
- **Numbers that do not add up.** Impact totals equal the sum of seeded donations.
  Standings follow from seeded results. Payouts equal escrow. Every figure on screen is
  derived, never typed.
- Multiple competing accents on one screen.
- `any`, empty `catch`, or leftover `console.log`.
- Floats in the money path.

---

## 8. Testing strategy

The testing story is part of what makes this impressive. Be specific about it in the
README.

**Property-based (`fast-check`)** — the settlement engine: conservation, non-negativity,
placement monotonicity, determinism under input permutation, remainder allocation.
Generate thousands of contests with random entrant counts, scores, ties, and prize
structures.

**Invariant** — `reconcile()` runs in CI against a seeded database and must come back
clean. Additionally, run it after a randomized sequence of several thousand operations
(issue, enter, withdraw, score, settle, void) and assert it is still clean. This is the
single highest-value test in the project.

**Concurrency** — fire N simultaneous `close` requests at one contest and assert exactly
one settlement occurs and escrow lands at zero. Same for double entry by one user.

**Contract** — record fixtures for every Purse endpoint and assert the SDK and the API
agree. Validate every documented error type is reachable and distinctly handled.

**Security** — grep the built client bundle for `sk_`. Assert `postMessage` with a wrong
origin is dropped. Assert an expired or reused embed token fails. Assert a webhook with
a bad signature or a stale timestamp is rejected.

**Domain** — illegal volleyball scorelines rejected; same-team double submission
rejected; dispute path; close blocked by unresolved matches.

**End-to-end (Playwright)** — two flows. Player: register → view pool → submit score →
opponent agrees → final → standings update. Organizer: resolve dispute → close through
frozen preview → payouts land in wallets → invariants clean.

---

## 9. Build order

Each phase ends runnable and demoable. Do not skip ahead; the value of the project is
that correctness arrives before features.

**Phase 0 — Foundations (½ day).** Monorepo, two apps, two databases, Docker Compose
for Postgres, Drizzle set up both sides, `@sideout/ui` tokens from section 6, the
ESLint boundary rule, `/health` on both, CI running typecheck and tests.

**Phase 1 — The ledger (2–3 days).** Accounts, journal, append-only enforcement at the
database role level, `balanceOf`, `reconcile()`, all seven invariants, the randomized
operation-sequence test. **Exit criteria: invariants hold after ten thousand random
operations.** Nothing else starts until this is true.

**Phase 2 — Contests and settlement (2–3 days).** Contest lifecycle with the transition
function and row locking, entries with escrow, append-only scores, the pure settlement
engine with full property tests, the preview-hash close mechanism. Exit: concurrent
close produces exactly one settlement.

**Phase 3 — Identity, eligibility, API (2 days).** Users, verification state machine,
restrictions, the versioned ruleset and evaluator with a case table, the three provider
seams with dev implementations, API keys with hashing, idempotency middleware, rate
limiting, the full v1 API surface.

**Phase 4 — SDK, embed, webhooks (2 days).** `@purse/types` message protocol,
`@purse/sdk`, the embed app with themed flows, origin and nonce validation, embed
tokens, the webhook dispatcher with signing and retry, the delivery log.

**Phase 5 — Purse operator console (1–2 days).** Tenants and keys, contest browser,
close flow with frozen preview, the ledger explorer, the live invariant panel, the
ruleset tester, webhook replay.

**Phase 6 — Sideout domain (2–3 days).** Tournaments, teams, pools, draw generation,
bracket advancement, standings with tiebreaks. Pure logic, heavily tested, no Purse
calls yet.

**Phase 7 — Sideout consensus and integration (2 days).** Score submissions, consensus
state machine, plausibility validation, dispute queue, then wire to Purse through the
SDK and the secret-key server calls, `purse_calls` audit, `/admin/purse`.

**Phase 8 — Sideout UI (3–4 days).** All seven screens against the design system, the
six transitions, PWA and the offline score queue, empty and error and loading states,
accessibility pass.

**Phase 9 — Polish and host (1–2 days).** Seeds that exercise every state, the two
Playwright flows, README with screenshots, deploy both services, custom domains, demo
reset job, uptime check.

Roughly three weeks of evenings. Phases 1 and 2 are the ones worth being slow about.

---

## 10. Hosting and operations

**DEFAULT topology:** Railway, on a personal account, on a personal domain. Keep this
entirely off any employer infrastructure.

| Service | Host | Domain |
|---|---|---|
| Sideout web | Railway | `sideout.<yourdomain>` |
| Purse API + embed | Railway | `purse.<yourdomain>` |
| Purse console | Railway | `console.purse.<yourdomain>` |
| Postgres | Railway managed, two logical databases | internal |

Requirements:

- Dockerfile per service, multi-stage, non-root, health check.
- Migrations run on deploy, forward-only, and fail the deploy on error.
- Separate `sandbox` and `live` API keys; the public demo runs `sandbox`.
- Secrets in Railway variables. Nothing in the repo. A `.env.example` lists every
  variable with a comment.
- `reconcile()` on a 15-minute cron; a failing invariant pages you.
- Nightly **demo reset** job that reseeds the public demo to a known good state, so the
  live link is always worth clicking.
- Structured JSON logs with a request id propagated across the service boundary, so a
  Sideout request can be traced into its Purse calls.
- An uptime check on both `/health` endpoints.
- `GET /health` returns commit sha, migration state, active ruleset version, SDK
  version, and last reconcile result.

Alternative if you would rather stay on Cloudflare: Workers plus Hyperdrive in front of
Neon Postgres works, but the append-only database-role enforcement from 4.2.2 is
fiddlier to set up and the ledger is the last place to accept friction. Railway is the
DEFAULT for that reason.

---

## 11. Acceptance criteria

**Platform correctness**
1. `reconcile()` clean after ten thousand randomized operations.
2. `UPDATE` and `DELETE` on `journal_entries` and `journal_lines` are revoked at the
   database role level, proven by a test that expects the failure.
3. Settlement conservation holds under property testing; no rounding unit is ever lost.
4. Settlement is deterministic under input permutation.
5. Concurrent `close` yields exactly one settlement; escrow ends at zero.
6. A `settled` contest has escrow zero and results summing to escrow.
7. Replaying any mutation with the same idempotency key creates nothing new and returns
   the original response.
8. `operator_close` contests cannot settle without an operator actor.
9. The payout hash from `/preview` is required by `close` and a mismatch is rejected.
10. No Purse account exists with asset `USD`.

**Boundary and security**
11. No `sk_` in any client bundle.
12. Sideout imports nothing from Purse but `@purse/sdk` and `@purse/types`, enforced by
    lint in CI.
13. `postMessage` from a non-allowlisted origin is dropped and counted.
14. Reused or expired embed tokens fail.
15. Webhooks with bad signatures or timestamps outside the window are rejected; valid
    duplicates are deduped.
16. Webhook retry and dead-lettering demonstrated with the receiver down.

**Product correctness**
17. Illegal volleyball scorelines rejected before any Purse call.
18. Two submissions from one team cannot reach consensus.
19. Disputes appear in the organizer queue and resolution is attributed in the audit log.
20. Tournament close is blocked by unresolved matches and the blocker is named.
21. Donations and contest value never share a table, a query, or a code path.

**Experience**
22. Usable one-handed at 390px; score entry is thumb-reachable.
23. All six transitions implemented and disabled under reduced-motion.
24. AA contrast verified across text tiers and on `--volt`.
25. Bracket is keyboard navigable.
26. A queued offline score survives reload and syncs on reconnect.
27. Nothing from section 7 appears anywhere.

**Shipped**
28. Both services deployed, custom domains, TLS, health endpoints green.
29. Seeds exercise every contest state and every verification state.
30. Both Playwright flows pass against the deployed environment.

---

## 12. Stretch, in order of value

1. **Signed score attestation.** Sign the canonicalized scoreline on-device with a
   WebCrypto key registered at team check-in, so Purse can verify a score was submitted
   by a registered device and not forged in transit. This is the strongest possible
   answer to "you ingest a number you cannot verify."
2. **Point-in-time ledger replay UI.** A slider that rebuilds every balance as of any
   journal entry. Trivial given append-only storage, and it demonstrates the payoff of
   the design choice.
3. **SSE live scoring** replacing the polling from D11.
4. **Second tenant.** Stand up a throwaway second product (an office ping-pong ladder)
   on the same Purse instance in an afternoon. Nothing proves a platform is a platform
   like a second consumer.
5. **Public status page** rendering the live invariant panel.
6. **Sandbox self-serve.** Let a visitor mint a sandbox key and hit the API from the
   docs page.

---

## 13. README requirements

The README is part of the deliverable and the first thing anyone reads. First person,
plain, no marketing voice.

1. One sentence on what this is, one screenshot of the live tournament screen, one of the
   ledger explorer.
2. A 60-second quickstart: clone, compose up, migrate, seed, two dev servers.
3. The architecture diagram and the four boundary rules from section 2.
4. **"How a score becomes a payout"** — the consensus state machine, then the contest
   lifecycle, then the settlement entry, end to end, with the actual journal lines.
5. **"How the ledger cannot drift"** — append-only, the seven invariants, and the
   randomized-operations test.
6. **"The rounding rule"** — state it explicitly and show the 100-split-three-ways
   example.
7. **The provider seam table** — each interface, its dev implementation, and the real
   vendor it stands in for. Say plainly that licensing and real KYC are deliberately out
   of scope and that this is an architecture exercise, not a licensed operator.
8. What is not built, and why: no real money, closed-loop assets only, donations
   separate and real.
9. The decisions from section 3 you made differently, and why.

Point 7 is the one that earns trust. Being precise about what is real and what is a seam
is more impressive than any claim of completeness.
