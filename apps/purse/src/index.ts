import { serve } from '@hono/node-server';

import { createLogger, errorFields, resolveBuildSha } from '@repo/logger';

import { createApp } from './app';
import { connect } from './db/client';
import { createSmsSender } from './embed/sms';
import { env } from './env';
import { assertRuntimeRole } from './ledger';
import { MIGRATIONS_FOLDER } from './paths';
import { createProviders, type Providers } from './providers';
import { deriveProcessKeys } from './secrets';
import { WebhookDispatcher } from './webhooks';

const config = env();
const logger = createLogger({ service: 'purse-api', level: config.logLevel });
const database = connect(config.databaseUrl);
const sha = resolveBuildSha(config.buildSha);

// The API serves only as a role that can append to the journal and never rewrite it. A
// process handed the migrator's URL, or a role with too much, stops here.
try {
  const privileges = await assertRuntimeRole(database.sql);
  logger.info('runtime role verified', { role: privileges.role, appendOnly: true });
} catch (error) {
  logger.error('runtime role check failed', errorFields(error));
  await database.close();
  process.exit(1);
}

if (config.internalApiToken === undefined && config.nodeEnv === 'production') {
  logger.warn('INTERNAL_API_TOKEN is not set; GET /internal/reconcile is closed');
}

// The three provider seams (spec 4.5). Production on a dev provider is refused unless
// ALLOW_DEV_PROVIDERS=true was set deliberately.
let providers: Providers;
try {
  providers = createProviders({ ...config.providers, nodeEnv: config.nodeEnv, devIdentity: config.providers.devIdentity });
  logger.info('providers configured', { identity: providers.identity.name, geo: providers.geo.name, risk: providers.risk.name, allowDevProviders: config.providers.allowDevProviders });
} catch (error) {
  logger.error('provider configuration refused', errorFields(error));
  await database.close();
  process.exit(1);
}

// The process secret and everything derived from it (sessions, sign-in codes, webhook
// secrets). Production refused to start without a real one in env.ts; here the stand-in
// is only ever a development convenience, and the log says so.
if (config.secretKeyIsDefault) {
  logger.warn('PURSE_SECRET_KEY is not set; using the development stand-in (never in production)');
}
const keys = deriveProcessKeys(config.secretKey);
const sms = createSmsSender(config.embed.smsProvider, logger.child({ component: 'sms' }));

const { app, embedDir } = createApp({
  sql: database.sql,
  db: database.db,
  logger,
  migrationsFolder: MIGRATIONS_FOLDER,
  sha,
  nodeEnv: config.nodeEnv,
  internalApiToken: config.internalApiToken,
  providers,
  keys,
  sms,
  embedDir: config.embed.staticDir,
  rateLimit: config.rateLimit,
  trustedProxyHops: config.trustedProxyHops,
});
if (embedDir === undefined) {
  logger.warn('embed app not found; /embed answers 404 until `pnpm --filter @purse/embed build` runs or PURSE_EMBED_DIR is set', { configured: config.embed.staticDir ?? null });
} else {
  logger.info('embed app served', { dir: embedDir, smsProvider: sms.name });
}

// The webhook dispatcher (spec 4.9) runs in this process unless WEBHOOK_DISPATCHER=off.
const dispatcher = config.webhooks.dispatcher
  ? new WebhookDispatcher({ db: database.db, keys, logger, pollIntervalMs: config.webhooks.pollIntervalMs, deliveryTimeoutMs: config.webhooks.deliveryTimeoutMs })
  : undefined;
dispatcher?.start();
if (dispatcher === undefined) logger.info('webhook dispatcher is off in this process (WEBHOOK_DISPATCHER=off)');

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, sha, nodeEnv: config.nodeEnv });
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  server.close((closeError) => {
    if (closeError) logger.error('server close failed', { reason: closeError.message });
    (dispatcher?.stop() ?? Promise.resolve())
      .then(() => database.close())
      .catch((error: unknown) => {
        logger.error('database close failed', { reason: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        process.exit(closeError ? 1 : 0);
      });
  });
  // Do not hang forever on stuck connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
