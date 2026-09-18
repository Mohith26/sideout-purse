import { Hono, type MiddlewareHandler } from 'hono';
import type { Id } from '@repo/ids';

import { readBody } from '../../http/body';
import { ApiFailure } from '../../http/envelope';
import { idempotency } from '../../http/idempotency';
import type { RequestScope } from '../../http/request-id';
import { auditRoutes } from './audit';
import { operatorAuth, sessionRoutes, signInRoutes } from './auth';
import { globalContestRoutes, tenantContestRoutes } from './contests';
import { globalLedgerRoutes, tenantLedgerRoutes } from './ledger';
import { globalReviewRoutes, tenantReviewRoutes } from './review';
import { rulesetRoutes } from './rulesets';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { findTenant, tenantsRoutes } from './tenants';
import { globalWebhookRoutes, tenantWebhookRoutes } from './webhooks';

/**
 * The operator console's API (spec 4.10), mounted at `/console`. It is the API the console
 * app (`apps/purse-console`) calls server-to-server; nothing here takes an API key, and no
 * secret key ever reaches the console's browser (docs/decisions.md, phase 5). The stack,
 * outermost first:
 *
 *   1. sign-in (`POST /console/auth/login`), the one route with no session, rate limited
 *      by address on failure;
 *   2. the operator session, `Authorization: Bearer cst_...` (`operatorAuth`);
 *   3. for `/tenants/:tenantId/*`, the tenant, loaded once and refused with 404 if unknown;
 *   4. the JSON body, read once;
 *   5. idempotency for every mutation under a tenant, stored in the tenant's namespace
 *      under the `console:` prefix; mutations outside a tenant (rulesets, the session)
 *      take no key and are idempotent at the service level.
 *
 * Every write is recorded under the operator actor (`operator:<opr_ id>`), and every
 * mutation goes through the same services the v1 API uses.
 */
export const CONSOLE_KEY_PREFIX = 'console:';

const TENANT_ID = /^tnt_[0-9a-f-]{36}$/;

export function consoleRoutes(deps: ConsoleDeps) {
  const open = new Hono<RequestScope>();
  open.route('/auth', signInRoutes(deps));

  const console = new Hono<ConsoleScope>();
  console.use('*', operatorAuth(deps));
  console.use('*', async (c, next) => {
    c.set('tenant', undefined);
    await next();
  });
  console.use('/tenants/:tenantId/*', loadTenant(deps));
  console.use('/tenants/:tenantId', loadTenant(deps));
  console.use('*', readBody());
  console.use(
    '*',
    idempotency<ConsoleScope>({
      db: deps.db,
      keyPrefix: CONSOLE_KEY_PREFIX,
      tenantOf: (c) => c.get('tenant')?.id as Id<'tnt'> | undefined,
      ...(deps.inProgressWaitMs === undefined ? {} : { inProgressWaitMs: deps.inProgressWaitMs }),
    }),
  );

  console.route('/auth', sessionRoutes(deps));
  console.route('/tenants', tenantsRoutes(deps));
  console.route('/tenants/:tenantId/webhooks', tenantWebhookRoutes(deps));
  console.route('/tenants/:tenantId/contests', tenantContestRoutes(deps));
  console.route('/tenants/:tenantId', tenantReviewRoutes(deps));
  console.route('/tenants/:tenantId', tenantLedgerRoutes(deps));
  console.route('/webhooks', globalWebhookRoutes(deps));
  console.route('/contests', globalContestRoutes(deps));
  console.route('/', globalReviewRoutes(deps));
  console.route('/', globalLedgerRoutes(deps));
  console.route('/rulesets', rulesetRoutes(deps));
  console.route('/audit', auditRoutes(deps));

  open.route('/', console);
  return open;
}

/** For `/tenants/:tenantId` and everything under it: the tenant, loaded once, or a 404 before any handler runs. */
function loadTenant(deps: Pick<ConsoleDeps, 'db'>): MiddlewareHandler<ConsoleScope> {
  return async (c, next) => {
    const tenantId = c.req.param('tenantId') ?? '';
    if (!TENANT_ID.test(tenantId)) {
      throw new ApiFailure({ type: 'invalid_request', code: 'validation_failed', message: 'tenantId must be a tenant id (tnt_...)', detail: { issues: [{ path: 'tenantId', message: 'must be a tnt_ id' }] } });
    }
    const tenant = await findTenant(deps.db, tenantId);
    if (tenant === undefined) throw new ApiFailure({ type: 'invalid_request', code: 'tenant_not_found', message: `No tenant ${tenantId}`, detail: { tenantId } }, 404);
    c.set('tenant', tenant);
    await next();
  };
}
