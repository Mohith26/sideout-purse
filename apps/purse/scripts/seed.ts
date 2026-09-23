import { parseArgs } from 'node:util';

import type { Id } from '@repo/ids';
import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { originsFromEnv, PINGPONG_TENANT, seedApiKeys, seedContests, seedOperatorAdmin, seedPlatformAccounts, seedRuleset, seedSecondTenant, seedSideoutTenant, seedTenantOrigins, seedTreasury, seedUsers, SIDEOUT_TENANT } from '../src/db/seed';
import { env, requireMigratorUrl } from '../src/env';

/**
 * Apply Purse's seed data, idempotently, as `purse_migrator`. Runs after `db:migrate`;
 * exits non-zero on any failure so a deploy step never continues with the tenant, its
 * platform accounts, the active ruleset or its users missing. The seed contests (a draft,
 * an open one with entrants, a settled one with results) go through the same services the
 * API uses and reconcile clean; CI runs `reconcile` right after this. The second tenant
 * (the ping-pong ladder, docs/second-tenant.md) gets its row, platform accounts, keys and
 * origins the same way; `--print-keys` prints both tenants' keys, each labelled.
 *
 *   pnpm --filter @purse/api db:seed -- --print-keys     print the plaintext of any API key
 *                                                        this run created (the only time it
 *                                                        exists outside the hash)
 *   pnpm --filter @purse/api db:seed -- --rotate-keys    revoke the seed keys and mint new ones
 *   pnpm --filter @purse/api db:seed -- --print-operator-password
 *                                                        print the console admin's password if
 *                                                        this run set it (the only time it exists)
 *   pnpm --filter @purse/api db:seed -- --rotate-operator-password
 *                                                        set a new admin password and sign the
 *                                                        account out everywhere
 */
// `pnpm ... db:seed -- --print-keys` hands the script a literal `--` first; drop it so the
// flags parse either way.
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
  options: {
    'print-keys': { type: 'boolean', default: false },
    'rotate-keys': { type: 'boolean', default: false },
    'print-operator-password': { type: 'boolean', default: false },
    'rotate-operator-password': { type: 'boolean', default: false },
  },
});

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
  const tenantId = tenant.id as Id<'tnt'>;

  const ruleset = await seedRuleset(database.db);
  logger.info(ruleset.created ? 'ruleset published' : 'ruleset already present', { version: ruleset.ruleset.version, active: ruleset.ruleset.active });

  const seededUsers = await seedUsers(database.db, tenantId);
  logger.info('seed users present', {
    tenant: tenant.id,
    created: seededUsers.users.filter((user) => user.created).length,
    users: seededUsers.users.map((user) => `${user.externalId}=${user.verification}`),
    duplicateFlagsRaised: seededUsers.duplicateFlags,
  });

  const keys = await seedApiKeys(database.db, tenantId, { rotate: args['rotate-keys'] });
  logger.info('api keys present', {
    tenant: tenant.id,
    created: keys.keys.filter((each) => each.created).length,
    keys: keys.keys.map((each) => `${each.key.label ?? each.key.id}=${each.key.keyPrefix}...`),
  });
  const minted = keys.keys.filter((each) => each.plaintext !== null);
  if (args['print-keys']) {
    if (minted.length === 0) {
      logger.warn('no key was created in this run, so there is no plaintext to print; use --rotate-keys to mint new seed keys');
    }
    for (const each of minted) {
      // The one place a key's plaintext is ever written out, and only when asked for.
      logger.info('api key plaintext', { label: each.key.label, kind: each.key.kind, environment: each.key.environment, scopes: each.key.scopes, key: each.plaintext });
    }
  } else if (minted.length > 0) {
    logger.info('api keys were created; rerun with --print-keys --rotate-keys to obtain plaintexts', { created: minted.map((each) => each.key.label) });
  }

  const origins = await seedTenantOrigins(database.db, tenantId, originsFromEnv(SIDEOUT_TENANT));
  logger.info('tenant origins present', { tenant: tenant.id, created: origins.created, origins: origins.origins });

  const second = await seedSecondTenant(database.db, { rotateKeys: args['rotate-keys'], extraOrigins: originsFromEnv(PINGPONG_TENANT) });
  logger.info(second.created ? 'second tenant created' : 'second tenant present', {
    id: second.tenant.id,
    name: second.tenant.name,
    platformAccounts: second.platform.accounts.length,
    keys: second.keys.keys.map((each) => `${each.key.label ?? each.key.id}=${each.key.keyPrefix}...`),
    origins: second.origins.origins,
  });
  for (const each of second.keys.keys.filter((each) => each.plaintext !== null)) {
    if (args['print-keys']) {
      // As above: the one time a plaintext is written out, and only when asked for.
      logger.info('api key plaintext', { tenant: second.tenant.id, label: each.key.label, kind: each.key.kind, environment: each.key.environment, scopes: each.key.scopes, key: each.plaintext });
    } else {
      logger.info('second tenant api key was created; rerun with --print-keys --rotate-keys to obtain plaintexts', { label: each.key.label });
    }
  }

  const seeded = await seedContests(database.db, tenantId);
  logger.info('seed contests present', {
    tenant: tenant.id,
    created: seeded.contests.filter((contest) => contest.created).length,
    contests: seeded.contests.map((contest) => `${contest.externalId}=${contest.state}`),
  });

  // The fiat rail (spec section 14): instruments, real deposits, one declined charge, one
  // withdrawal in flight, and the settled cash contest whose rake funds the fee account.
  // After the contests, because the cash contest is entered with money deposited here.
  const treasury = await seedTreasury(database.db, tenantId);
  logger.info('seed treasury present', {
    tenant: tenant.id,
    methods: treasury.methods,
    deposits: treasury.deposits,
    withdrawals: treasury.withdrawals,
    declined: treasury.declined,
    cashContest: treasury.cashContest === null ? 'none' : `${treasury.cashContest.externalId}=${treasury.cashContest.state}`,
  });

  const admin = await seedOperatorAdmin(database.db, {
    ...(process.env['PURSE_OPERATOR_ADMIN_EMAIL'] === undefined ? {} : { email: process.env['PURSE_OPERATOR_ADMIN_EMAIL'] }),
    rotate: args['rotate-operator-password'],
  });
  logger.info(admin.created ? 'console admin created' : 'console admin present', { id: admin.operator.id, email: admin.operator.email, role: admin.operator.role, passwordSet: admin.password !== null });
  if (args['print-operator-password']) {
    if (admin.password === null) {
      logger.warn('the console admin password was not set in this run, so there is nothing to print; use --rotate-operator-password to set a new one');
    } else {
      // The one place the password is ever written out, and only when asked for.
      logger.info('console admin password', { email: admin.operator.email, password: admin.password });
    }
  } else if (admin.password !== null) {
    logger.info('console admin password was set; rerun with --print-operator-password --rotate-operator-password to obtain it');
  }
} catch (error) {
  logger.error('seed failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
