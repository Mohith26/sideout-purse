import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DemoAccounts } from '../../components/auth/DemoAccounts';
import { SignInForm } from '../../components/auth/SignInForm';
import { safeNextPath } from '../../lib/redirects';
import { listDemoAccounts } from '../../server/demo-accounts';
import { pageContext } from '../../server/pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in' };

/**
 * Phone sign-in. A signed-in visitor is sent straight back to where they were going; `next`
 * is only ever honoured as a same-origin path. On the public demo (`DEMO_ACCOUNTS`,
 * `docs/demo-accounts.md`) the account picker sits above the phone form, which stays
 * exactly as it is.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  const target = safeNextPath(next, '/me');
  const { app, user, clock } = await pageContext();
  if (user !== null) redirect(target);
  const demoAccounts = app.env.demoAccounts ? await listDemoAccounts(app.db, clock) : [];
  const intro = 'Enter your phone number and we text you a six-digit code. No password, no email.';
  return (
    <div className={demoAccounts.length > 0 ? 'mx-auto max-w-2xl' : 'mx-auto max-w-md'}>
      <h1 className="type-display-l">Sign in</h1>
      {demoAccounts.length > 0 ? (
        <>
          <div className="mt-6">
            <DemoAccounts accounts={demoAccounts} next={target} />
          </div>
          <h2 className="type-heading mt-10">Sign in with your phone</h2>
          <p className="mt-2 text-text-secondary">{intro}</p>
        </>
      ) : (
        <p className="mt-2 text-text-secondary">{intro}</p>
      )}
      <div className="mt-6">
        <SignInForm next={target} />
      </div>
    </div>
  );
}
