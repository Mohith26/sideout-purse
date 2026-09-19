# Demo accounts

The public demo's sign-in switch for Sideout. Production issues no one-time code without an
SMS provider (`docs/decisions.md`, phase 6) and the dev login is compiled out of production
builds, so a visitor to the hosted demo could read every screen and sign in as no one. With
`DEMO_ACCOUNTS=true`, `/sign-in` offers a "Demo accounts" section above the unchanged phone
form: six curated seeded people, each with a one-line story and its live state, and one
button signs the visitor in as that person. Off by default. The decisions behind it are
`docs/decisions.md`, "Stretch: demo accounts decisions".

## The switch

| Variable | Where | Meaning |
|---|---|---|
| `DEMO_ACCOUNTS` | the server, **and** the build (`apps/sideout/Dockerfile` build argument, default `false`) | `true` or `1` turns the picker, `POST /api/auth/demo` and the `demoAccounts: true` field on `/health` on. Anything else, or unset, is off. |
| `NEXT_PUBLIC_DEMO_ACCOUNTS` | derived, never set by hand | `next.config.ts` derives it from `DEMO_ACCOUNTS` at build time and `next build` inlines it; `src/env.ts` compares it with the runtime `DEMO_ACCOUNTS` and refuses to boot a build made for the other setting. |

`src/env.ts` refuses `DEMO_ACCOUNTS=true` beside anything that is not demo-safe: a live
Purse key (`sk_live_`, `pk_live_`), a Stripe key that is not test-mode, or an SMS provider
other than the log sender. Under the switch, and only under it, production may run the
`dev` donation provider when no Stripe key is configured, so registering for a paid event
completes without Stripe (the donation settles fifteen seconds later, as it does locally);
a configured Stripe key still wins, so adding test keys later changes nothing here.

## The six accounts

Named in `apps/sideout/src/db/seed/demo.ts` by seeded phone number and resolved against the
live rows by `src/server/demo-accounts.ts` on every request, so each card says what that
person can do right now and survives whatever the demo did to the rows since the reset.

| Card | Who | Lands on | What it shows |
|---|---|---|---|
| Captain A | captain of team A in the Sandbar Classic quarterfinal awaiting scores | the match | their scoreline is in; revise it, or watch the other side answer |
| Captain B | captain of team B in the same match | the match | the answering sheet: the same result makes the match final, a different one opens a dispute |
| Registering captain | captain of the Pier 9 Open pair whose payment failed | the register screen | the entry donation (the dev provider under the switch), then the Purse contest entry in Purse's frame |
| Organizer | the seeded organizer | the console | the court board, the dispute queue, the Purse reconciliation page, the two-step close |
| Player Purse refuses | a Pier 9 captain whose checkout lapsed | the profile | a rejected identity check and a date of birth under the minimum age: the terminal row with a support path, and every contest entry refused |
| Player still to verify | the Community Cup captain waiting on a partner | the profile | linked to Purse, not verified: the identity row opens Purse's identity flow |

The two Purse states are set by the seed's Purse walk (`seedDemoAccounts` in
`src/db/seed/purse.ts`) after every seeded entry, so the seeded contests keep their
participants; both `db:seed` and the nightly demo reset run it, so the roster comes back
every morning. Every call is idempotent under a fixed key.

## Signing in

`POST /api/auth/demo` with `{ "account": "<key>" }` (one of `captain_a`, `captain_b`,
`registrant`, `organizer`, `refused`, `verifying`; never a user id or a phone) answers the
ordinary session cookie with `via: "demo"` inside the signed payload, writes
`user.demo_signed_in` on the user, and is rate-limited per client address (30 per ten
minutes) and process-wide (600); every cap is consulted before any is charged. `GET
/api/auth/demo` is the roster with its state. Both answer 404 while the switch is off. The
shell shows a fixed fault-red "Demo · name" pill on every screen of such a session until
sign-out (`POST /api/auth/logout`, the same as any session). The phone form and its routes
are untouched either way.

## Turning it on

Locally: `DEMO_ACCOUNTS=true pnpm --filter @sideout/web dev` (the dev server reads the
variable directly), or for the production build `DEMO_ACCOUNTS=true pnpm --filter
@sideout/web build` then `DEMO_ACCOUNTS=true pnpm --filter @sideout/web start`.

Hosted (`docs/deploy.md`): set `DEMO_ACCOUNTS=true` on the `sideout` service; Railway hands
service variables to the build as well, where the Dockerfile declares the argument, so the
build and the runtime agree. Redeploy, then check `/health` reports `"demoAccounts": true`
and `/sign-in` shows the picker.

## Tests

- `apps/sideout/test/env.test.ts`: off by default, refused beside a live key, the dev
  provider in production under the switch only, the build/runtime disagreement.
- `apps/sideout/test/api/demo.test.ts`: 404 while off, the roster with its state, a
  sign-in marks and audits, unknown keys refused, both rate limits, the phone sign-in
  untouched.
- `apps/sideout/test/seed.test.ts`: the roster against the dataset.
- `apps/sideout/e2e/demo.spec.ts`: through the picker as each captain, the organizer and
  the two Purse-state players; skips itself when the build under test was made without the
  switch (CI builds with it on; `playwright.config.ts`).
