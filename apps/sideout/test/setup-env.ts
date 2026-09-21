import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load `apps/sideout/.env` if present, without overriding anything CI already set; else the `pnpm db:setup` default. */
const envFile = path.resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env['SIDEOUT_DATABASE_URL_TEST'] ??= 'postgres://sideout_app:sideout_app@localhost:5432/sideout_test';

/**
 * `.env` is a developer's configuration of the running app, not the suite's. It is loaded
 * above for one reason — the connection string — and everything else in it is a behaviour
 * switch the tests assert the default of: `SIDEOUT_PURSE_SECRET_KEY` turns the Purse
 * integration on (so a registration reports a real entry instead of `not_wired`, and a
 * tournament's audit trail gains `purse_contest_*` rows), `DEMO_ACCOUNTS` adds routes that
 * a test asserts answer 404 while the switch is off, and the Stripe and SMS variables pick
 * a different provider.
 *
 * Inheriting those made the suite depend on how the machine it runs on happens to be
 * configured: following the README (`docs/deploy.md`, `docs/demo-accounts.md`) and wiring
 * Sideout to a local Purse is enough to fail four tests that have nothing to do with the
 * change being made, while CI — which sets no `.env` — stays green. So the suite clears
 * them and each test opts in explicitly: the integration walk takes its configuration from
 * `PURSE_INTEGRATION_*`, named apart for exactly this reason, and the rest build an env
 * through `loadEnv({ ... })`.
 */
for (const name of [
  'PURSE_API_URL',
  'SIDEOUT_PURSE_SECRET_KEY',
  'PURSE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_PURSE_ORIGIN',
  'NEXT_PUBLIC_PURSE_TENANT_ID',
  'DEMO_ACCOUNTS',
  'NEXT_PUBLIC_DEMO_ACCOUNTS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'SMS_PROVIDER',
  'SESSION_SECRET',
]) {
  delete process.env[name];
}
