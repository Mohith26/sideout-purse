import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SignInForm } from '../../components/auth/SignInForm';
import { safeNextPath } from '../../lib/redirects';
import { pageContext } from '../../server/pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in' };

/** Phone sign-in. A signed-in visitor is sent straight back to where they were going; `next` is only ever honoured as a same-origin path. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  const target = safeNextPath(next, '/me');
  const { user } = await pageContext();
  if (user !== null) redirect(target);
  return (
    <div className="mx-auto max-w-md">
      <h1 className="type-display-l">Sign in</h1>
      <p className="mt-2 text-text-secondary">Enter your phone number and we text you a six-digit code. No password, no email.</p>
      <div className="mt-6">
        <SignInForm next={target} />
      </div>
    </div>
  );
}
