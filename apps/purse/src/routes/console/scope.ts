import type { Db } from '../../db/client';
import type { Operator, OperatorSession, Tenant } from '../../db/schema';
import type { BodyScope } from '../../http/body';
import type { IdempotencyScope } from '../../http/idempotency';
import type { RequestScope } from '../../http/request-id';
import type { Actor } from '../../ledger/audit';
import type { Providers } from '../../providers';
import type { ProcessKeys } from '../../secrets';

/** The signed-in operator, their session, and the audit actor every console write is recorded under. */
export type OperatorScope = { Variables: { operator: Operator; session: OperatorSession; actor: Actor } };

/** The tenant a `/tenants/:tenantId/*` route acts on, loaded before the handler; `undefined` off those paths. */
export type TenantScope = { Variables: { tenant: Tenant | undefined } };

export type ConsoleScope = RequestScope & OperatorScope & TenantScope & BodyScope & IdempotencyScope;

export type ConsoleDeps = {
  db: Db;
  /** The derived process keys (`src/secrets.ts`); the webhook routes seal signing secrets with them. */
  keys: ProcessKeys;
  providers: Providers;
  /** How many proxies append to `X-Forwarded-For`; the sign-in limit is keyed by the address they reveal. */
  trustedProxyHops: number;
  /** The limiter's clock, for tests. */
  clock?: () => number;
  inProgressWaitMs?: number;
};
