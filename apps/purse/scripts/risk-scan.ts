import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { SIDEOUT_TENANT_ID } from '../src/db/seed';
import { flagCollusion, requireActiveRuleset } from '../src/eligibility';
import { env } from '../src/env';

/**
 * Run the head-to-head collusion scan (spec 4.6) over the Sideout tenant's settled
 * contests and raise an operator flag for every qualifying pair not yet flagged. Surfaces
 * only; nothing is blocked. Connects as the runtime role. The same scan runs inside every
 * head-to-head settlement for the pair it involved; this is the full rescan, for a ruleset
 * change or a backfill.
 *
 *   pnpm --filter @purse/api risk:scan
 */
const logger = createLogger({ service: 'purse-risk-scan', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1, applicationName: 'purse-risk-scan' });

try {
  const ruleset = await requireActiveRuleset(database.db);
  const scan = await flagCollusion(database.db, { tenantId: SIDEOUT_TENANT_ID, ruleset });
  logger.info('collusion scan complete', {
    rulesetVersion: ruleset.version,
    minMeetings: ruleset.collusion.minMeetings,
    oneSidedShare: ruleset.collusion.oneSidedShare,
    pairs: scan.pairs.length,
    newFlags: scan.flags.length,
    nodeEnv: config.nodeEnv,
  });
} catch (error) {
  logger.error('collusion scan failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
