import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ConsoleMeResource } from '@purse/types';

import { Nav } from '../../components/Nav';
import { SignOutButton } from '../../components/SignOutButton';
import { StateChip } from '../../components/StateChip';
import { load } from '../../server/api';

/**
 * Every screen but sign-in sits in this frame: the rail with the sections and the signed-in
 * operator, the content column. Loading `/auth/me` here is what makes every page behind
 * the frame need a live session (a 401 redirects to sign-in).
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const me = await load<ConsoleMeResource>('/auth/me');
  return (
    <div className="console">
      <aside className="console__rail">
        <Link href="/" className="console__brand">
          <span className="display">Purse</span>
          <span className="console__brand-sub">console</span>
        </Link>
        <Nav />
        <div className="console__operator">
          <span>{me.operator.email}</span>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <StateChip value={me.operator.role} />
            <Link href="/account" className="so-link">
              Account
            </Link>
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main className="console__main">{children}</main>
    </div>
  );
}
