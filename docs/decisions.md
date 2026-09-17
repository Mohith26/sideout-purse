# Decisions

The system spec ([`system-spec.md`](./system-spec.md), section 3) leaves twelve decisions
open and gives each a DEFAULT with a stated reason. Every one of them is taken at its
DEFAULT. The reason recorded next to each answer is the spec's own; where phase 0 had to
depart from a spec value for a stated reason, that is recorded separately at the bottom.

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
`#7D8591` keeps the same cool neutral hue and lands at 4.6:1 on `--bg-overlay`, the
lightest surface, so every tier passes on every surface. The contrast unit test in
`@sideout/ui` asserts this for every text tier on every background tier and would fail
against the original value.

## Phase 0 implementation choices worth knowing

These are not spec decisions; they are the answers phase 0 gave to questions the spec
leaves to the builder, recorded so later phases do not relitigate them.

- **Tailwind 4, CSS-first.** The `@sideout/ui` "Tailwind preset" is a CSS `@theme` block
  mapping every token to a Tailwind utility (`bg-base`, `text-secondary`, `rounded-card`,
  `duration-base`, `ease-out-expo`, ...). Tailwind 4 has no JavaScript preset; the CSS
  theme is the equivalent and the same file works in any consumer, including the Purse
  embed app and operator console in phases 4 and 5.
- **Primitives are plain CSS, not Tailwind classes.** `Button` and `StatusPill` are styled
  from the token custom properties in `@sideout/ui/styles.css`, so a consumer never has to
  configure Tailwind content scanning of the package for the primitives to render.
- **"Archivo Expanded" is the Archivo variable font at width 125.** Google Fonts ships
  Archivo with a `wdth` axis (62–125); there is no separate Expanded family. Display text
  sets `font-stretch: 125%`.
- **One `.env` per app, never one at the root.** D2 says the two connection strings are
  never loaded into one process. `apps/purse/.env` holds `PURSE_DATABASE_URL`;
  `apps/sideout/.env` holds `SIDEOUT_DATABASE_URL`. `pnpm db:migrate` at the root runs each
  app's migrator as a separate process for the same reason.
- **Ids are UUID v7 with a typed prefix and a CHECK constraint.** `tnt_`, `usr_`, `aud_`,
  `chr_` and the rest live in one registry in `@repo/ids`; each table checks its own prefix
  at the database level.
- **The Sideout tenant row is seeded by a migration, not a seed script.** It is reference
  data the platform cannot function without and its id must be stable across environments,
  so it belongs to the schema's history. Its id is `SIDEOUT_TENANT_ID` in
  `apps/purse/src/tenants.ts`.
