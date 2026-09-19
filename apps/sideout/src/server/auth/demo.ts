import type { Db } from '../../db/client';
import type { DemoAccountKey } from '../../db/seed/demo';
import type { Env } from '../../env';
import { writeAudit } from '../audit';
import { findDemoAccount, type DemoAccount } from '../demo-accounts';
import { failure } from '../http/errors';
import type { RateLimiter } from './rate-limit';

/**
 * Demo sign-in (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`): a visitor to the public demo
 * picks one of the curated seeded users and gets a normal session marked `via: 'demo'`
 * (`session.ts`). Nothing here touches the phone-code sign-in.
 *
 * The switch is checked on every call (the route also answers 404), the account must be
 * one the roster names (never an arbitrary user id or phone), every sign-in writes
 * `user.demo_signed_in` on the user, and the per-address and process-wide buckets keep a
 * script from churning sessions. As with the phone sign-in, every cap is consulted before
 * any is charged.
 */
export const DEMO_AUDIT_ACTION = 'user.demo_signed_in';

const TEN_MINUTES = 10 * 60_000;
/** Demo sign-ins over a ten-minute window: per client address, and for the whole process. */
export const DEMO_SIGN_IN_LIMITS = {
  perAddress: { limit: 30, windowMs: TEN_MINUTES, maxKeys: 10_000 },
  global: { limit: 600, windowMs: TEN_MINUTES, maxKeys: 1 },
} as const;

export type DemoLimiters = { perAddress: RateLimiter; global: RateLimiter };

export type DemoSignInDeps = { db: Db; env: Env; limiters: DemoLimiters };

/** The switch is off: the demo routes do not exist. */
export function assertDemoAccountsEnabled(env: Env): void {
  if (!env.demoAccounts) throw failure.notFound('not_found', 'Not found.');
}

export type DemoSignInInput = {
  account: DemoAccountKey;
  /** The client address as `clientAddress` judged it. */
  address: string;
  now: Date;
};

export async function demoSignIn(deps: DemoSignInDeps, input: DemoSignInInput): Promise<DemoAccount> {
  assertDemoAccountsEnabled(deps.env);
  const caps = [
    ['address', deps.limiters.perAddress, input.address],
    ['global', deps.limiters.global, 'global'],
  ] as const;
  for (const [scope, limiter, key] of caps) {
    const verdict = limiter.check(key, input.now);
    if (!verdict.allowed) {
      throw failure.rateLimited('too_many_requests', 'Too many demo sign-ins; try again shortly.', { scope, retryAfterSeconds: verdict.retryAfterSeconds });
    }
  }
  for (const [, limiter, key] of caps) limiter.hit(key, input.now);

  const clock = { now: input.now, reservationTtlMs: deps.env.reservationTtlMs };
  const account = await findDemoAccount(deps.db, clock, input.account);
  if (account === null) throw failure.notFound('demo_account_unavailable', 'That demo account is not on this database; run the demo reset.');
  await writeAudit(deps.db, {
    actor: { kind: account.role, userId: account.userId },
    action: DEMO_AUDIT_ACTION,
    subjectType: 'user',
    subjectId: account.userId,
    detail: { account: account.key, method: 'demo_accounts' },
    at: input.now,
  });
  return account;
}
