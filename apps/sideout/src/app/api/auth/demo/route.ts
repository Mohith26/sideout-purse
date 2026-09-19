import { z } from 'zod';

import { DEMO_ACCOUNT_KEYS } from '../../../../db/seed/demo';
import { clientAddress } from '../../../../server/auth/client-address';
import { assertDemoAccountsEnabled, demoSignIn } from '../../../../server/auth/demo';
import { issueSession, sessionCookieHeader } from '../../../../server/auth/session';
import { appContext } from '../../../../server/context';
import { listDemoAccounts } from '../../../../server/demo-accounts';
import { parseJsonBody } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({ account: z.enum(DEMO_ACCOUNT_KEYS) }).strict();

const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`). Both
 * handlers answer 404 while the switch is off, so the route is indistinguishable from an
 * absent one; the phone-code sign-in (`/api/auth/request-code`, `/verify`) is untouched
 * either way.
 *
 * GET  — the curated accounts with their live state (what `/sign-in` renders).
 * POST — sign in as one of them: a normal session cookie marked `via: 'demo'`, a
 *        `user.demo_signed_in` audit row, rate-limited per address and process-wide.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    assertDemoAccountsEnabled(env);
    const now = new Date();
    const accounts = await listDemoAccounts(db, { now, reservationTtlMs: env.reservationTtlMs });
    return ok({ accounts }, { headers: NO_STORE });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env, demoLimiters } = appContext();
    assertDemoAccountsEnabled(env);
    const body = await parseJsonBody(request, bodySchema);
    const now = new Date();
    const account = await demoSignIn({ db, env, limiters: demoLimiters }, { account: body.account, address: clientAddress(request.headers, env.trustedProxyHops), now });
    const session = issueSession(account.userId, env.sessionSecret, now, { via: 'demo' });
    return ok(
      { user: { id: account.userId, displayName: account.displayName, role: account.role }, account: account.key, href: account.href, demo: true, sessionExpiresAt: session.expiresAt.toISOString() },
      { headers: { ...NO_STORE, 'set-cookie': sessionCookieHeader(session.token, { secure: env.nodeEnv === 'production' }) } },
    );
  });
}
