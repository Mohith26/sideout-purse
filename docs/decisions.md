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
