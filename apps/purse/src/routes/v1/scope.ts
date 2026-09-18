import type { Db } from '../../db/client';
import type { AuthScope } from '../../http/auth';
import type { BodyScope } from '../../http/body';
import type { IdempotencyScope } from '../../http/idempotency';
import type { RequestScope } from '../../http/request-id';
import type { Providers } from '../../providers';

/** What every v1 handler sees: the request id and logger, the authenticated key, the parsed body, and the request's database handle. */
export type V1Scope = RequestScope & AuthScope & BodyScope & IdempotencyScope;

export type V1Deps = {
  db: Db;
  providers: Providers;
};
