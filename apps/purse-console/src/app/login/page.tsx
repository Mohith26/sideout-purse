import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ConsoleMeResource } from '@purse/types';

import { consoleFetch } from '../../server/api';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

/** Sign in. An operator with a live session is sent straight in. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = next !== undefined && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const me = await consoleFetch<ConsoleMeResource>('/auth/me');
  if (me.ok) redirect(target);
  return (
    <div className="login">
      <div className="login__card">
        <LoginForm next={target} />
      </div>
    </div>
  );
}
