import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { clearDemoData, KEPT_TABLES } from '../src/db/demo-reset';
import { seedContests, seedOperatorAdmin, seedPlatformAccounts, seedRuleset, seedSideoutTenant, seedTenantOrigins, seedUsers } from '../src/db/seed';
import { env, requireMigratorUrl } from '../src/env';

/**
 * Reset the public demo's Purse database to the seed (spec section 10, the nightly demo
 * reset): delete every demo row as `purse_migrator`, keep the tenant's configuration and
 * the platform's record (`src/db/demo-reset.ts` lists both), then apply the seed on the
 * empty tables exactly as `db:seed` does. Sideout's half runs after this one, against the
 * Purse API, so the seeded events are mirrored into the fresh contests
 * (`apps/sideout/scripts/demo-reset.ts`). Exits non-zero on any failure.
 *
 * Refuses to run unless `DEMO_RESET=allow` is set: the job that owns this is the only
 * process that should ever hold both the migrator's connection string and this switch.
 *
 *   DEMO_RESET=allow pnpm --filter @purse/api demo:reset
 */
const logger = createLogger({ service: 'purse-demo-reset', level: 'info' });
if (process.env['DEMO_RESET'] !== 'allow') {
  logger.error('refusing to reset: DEMO_RESET=allow is not set');
  process.exit(2);
}
const config = env();
const database = connect(requireMigratorUrl(config), { max: 1, applicationName: 'purse-demo-reset' });

try {
  const cleared = await clearDemoData(database.db);
  logger.info('demo data cleared', { database: cleared.database, deleted: cleared.deleted, kept: KEPT_TABLES });

  const { tenant } = await seedSideoutTenant(database.db);
  const platform = await seedPlatformAccounts(database.db, tenant.id);
  const ruleset = await seedRuleset(database.db);
  const users = await seedUsers(database.db, tenant.id as `tnt_${string}`);
  const origins = await seedTenantOrigins(
    database.db,
    tenant.id as `tnt_${string}`,
    (process.env['PURSE_TENANT_ORIGINS'] ?? '')
      .split(',')
      .map((each) => each.trim())
      .filter((each) => each !== ''),
  );
  const contests = await seedContests(database.db, tenant.id as `tnt_${string}`);
  const admin = await seedOperatorAdmin(database.db, process.env['PURSE_OPERATOR_ADMIN_EMAIL'] === undefined ? {} : { email: process.env['PURSE_OPERATOR_ADMIN_EMAIL'] });
  logger.info('demo reset complete', {
    tenant: tenant.id,
    platformAccounts: platform.accounts.length,
    rulesetVersion: ruleset.ruleset.version,
    users: users.users.map((user) => `${user.externalId}=${user.verification}`),
    origins: origins.origins,
    contests: contests.contests.map((contest) => `${contest.externalId}=${contest.state}`),
    consoleAdmin: admin.operator.email,
    nodeEnv: config.nodeEnv,
  });
} catch (error) {
  logger.error('demo reset failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
