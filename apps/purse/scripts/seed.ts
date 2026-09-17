import { connect } from '../src/db/client';
import { seedSideoutTenant } from '../src/db/seed';
import { env } from '../src/env';
import { createLogger, errorFields } from '../src/logger';

/**
 * Apply Purse's seed data, idempotently. Runs after `db:migrate`; exits non-zero on any
 * failure so a deploy step never continues with the tenant missing.
 */
const logger = createLogger({ service: 'purse-seed', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1 });

try {
  const { tenant, created } = await seedSideoutTenant(database.db);
  logger.info(created ? 'tenant created' : 'tenant already present', {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    nodeEnv: config.nodeEnv,
  });
} catch (error) {
  logger.error('seed failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
