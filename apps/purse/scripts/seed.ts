import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { seedPlatformAccounts, seedSideoutTenant } from '../src/db/seed';
import { env, requireMigratorUrl } from '../src/env';

/**
 * Apply Purse's seed data, idempotently, as `purse_migrator`. Runs after `db:migrate`;
 * exits non-zero on any failure so a deploy step never continues with the tenant or its
 * platform accounts missing.
 */
const logger = createLogger({ service: 'purse-seed', level: 'info' });
const config = env();
const database = connect(requireMigratorUrl(config), { max: 1, applicationName: 'purse-seed' });

try {
  const { tenant, created } = await seedSideoutTenant(database.db);
  logger.info(created ? 'tenant created' : 'tenant already present', {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    nodeEnv: config.nodeEnv,
  });
  const platform = await seedPlatformAccounts(database.db, tenant.id);
  logger.info('platform accounts present', {
    tenant: tenant.id,
    created: platform.created,
    total: platform.accounts.length,
    accounts: platform.accounts.map((account) => `${account.kind}/${account.asset}`),
  });
} catch (error) {
  logger.error('seed failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
