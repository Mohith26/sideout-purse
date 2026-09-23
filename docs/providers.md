# Provider seams

Where something cannot be built honestly (real identity verification, licensed
geolocation, third-party risk scoring, moving real money) Purse specifies a provider seam instead of
pretending (system spec, sections 0 and 4.5): an interface Purse calls at one place, a
deterministic dev implementation behind it, and a name for the licensed vendor a real
platform would plug in. Licensing and real KYC are deliberately out of scope; this is an
architecture exercise, not a licensed operator. Phase 9 lifts this table into the README.

| Seam | Interface (`apps/purse/src/providers/types.ts`) | Called from | Dev implementation (`src/providers/dev/`) | Stands in for |
|---|---|---|---|---|
| Identity | `IdentityProvider.verify(user) → { outcome: verified \| rejected \| pending, providerRef, reverifyAfter? }` | `startVerification` (`POST /v1/users/:id/verification`), between two short transactions, never under a row lock | `identity.ts`: an external id on the deny list is `rejected`, on the pending list stays `pending`, on the allow list is `verified`; anyone else is `verified` when a display name and a date of birth were supplied and `rejected` otherwise. The reference is a digest of the user id and outcome, never anything about the user. | **Persona** or **Socure**: a hosted inquiry opened inside the embed iframe and completed through a webhook, with document and selfie checks that never enter this database (`user_verification` has no column that could hold one, and `provider_ref` is held to a token shape by a CHECK). |
| Geolocation | `GeoProvider.resolve({ declaredRegion?, ip? }) → { region \| null, confidence 0..1, source: ip \| declared \| provider }` | `upsertUser` and `enterContest` when the request carries a `location`; the result is the user's current row in `user_locations` and is copied onto every decision | `geo.ts`: a declared region is taken at face value (confidence 0.6); otherwise the address is looked up in a small table of RFC 5737 / 6598 documentation prefixes (`203.0.113.x` → `US-TX`, `198.51.100.x` → `US-CA`, `192.0.2.x` → `US-NC`, `100.64.x` → `US-NY`, `100.65.x` → `GB`; confidence 0.9); loopback, private and unknown addresses resolve to no region, which the evaluator reports as `region_unknown`. | **GeoComply**: a device-side fix with a licensed geofence, a confidence score and a fraud verdict (VPNs, spoofing), which is what a regulator expects behind `permittedRegions`. |
| Risk | `RiskProvider.assess(transaction) → { decision: allow \| review \| deny, signals[] }` | `enterContest`, alongside the pure evaluator, with the journal's velocity, the user's open flags and account age | `risk.ts`: the spec 4.6 velocity and duplicate-account rules as signals (`velocity_near_24h_limit`, `velocity_near_7d_limit`, `duplicate_identity_open`, `new_account_max_stake`); any signal answers `review`, which becomes an `operator_flags` row and lets the entry through. The dev provider never answers `deny`. The evaluator enforces the limits themselves. | **Sardine**: device, behaviour and payment signals scored in real time, able to deny outright. |
| Funding | `FundingProvider.charge(request) \| .payout(request) → { outcome: succeeded \| pending \| declined, providerRef, feeUsdCents, declineCode? }` | `deposit` and `requestWithdrawal` (`POST /v1/payments/deposits`, `/withdrawals`), outside the writing transaction, never with a row lock held | `funding.ts`: deterministic, because a demo that declines at random is a demo nobody trusts. Every answer is a pure function of the idempotency key. Models real interchange (2.9% + 30c on cards, a flat 80c on a bank debit), declines a scripted set of amounts on purpose so the failure path is reachable, and answers `pending` rather than `succeeded` on a payout because ACH takes days. | **Stripe**, **Adyen** or **Checkout.com**, with Purse as merchant of record: a tokenised instrument, a charge or payout, and the outcome by webhook. The instrument is already a token by the time it reaches this seam, which is what keeps this database out of PCI scope: `payment_methods` has no column a PAN, a CVV or an account number could be written to, and a CHECK holds `last4` to four digits. |

## Configuration

Every seam is selected by environment (`apps/purse/src/env.ts`); only `dev` exists today.
A vendor integration adds its name to `PROVIDER_IMPLEMENTATIONS` there and a branch in
`createProviders` (`src/providers/index.ts`), and nothing else in Purse changes.

| Variable | Default | Meaning |
|---|---|---|
| `IDENTITY_PROVIDER` | `dev` | Fills the identity seam. |
| `GEO_PROVIDER` | `dev` | Fills the geolocation seam. |
| `RISK_PROVIDER` | `dev` | Fills the risk seam. |
| `FUNDING_PROVIDER` | `dev` | Fills the funding seam (the fiat rail). |
| `ALLOW_DEV_PROVIDERS` | `false` | A production process (`NODE_ENV=production`) refuses to start on any `dev` provider unless this is `true`, set on purpose for a demo. |
| `DEV_IDENTITY_ALLOW` | empty | Comma-separated external ids the dev identity provider verifies regardless of demographics. |
| `DEV_IDENTITY_DENY` | empty | External ids it rejects. |
| `DEV_IDENTITY_PENDING` | empty | External ids it leaves pending, so a demo can show the waiting state. |

The seed drives the six seed users through the same provider with its own lists
(`SEED_IDENTITY_LISTS` in `apps/purse/src/db/seed.ts`), which is how a freshly seeded
database shows every verification state.

## What crosses a seam

The interfaces carry the minimum a decision needs and return opaque references: the
identity seam is told a user's id, external id, display name, date of birth and phone;
the geolocation seam a declared region and an address; the risk seam an entry with the
platform's own velocity figures; the funding seam an amount in US cents and a provider token. Nothing that crosses a seam is a document, an image or a
raw location trace, and nothing a seam returns is stored except its outcome, its
reference, its region and confidence, or its signals.
