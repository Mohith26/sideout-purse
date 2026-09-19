'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@sideout/ui';

import { api } from '../lib/api-client';

type Me = { player: { id: string; name: string } | null };

/** Who is signed in, links to the ladder and the audit, and a sign-out. */
export function HeaderNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me['player'] | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void api<Me>('/api/session').then((result) => {
      if (live) setMe(result.ok ? result.data.player : null);
    });
    return () => {
      live = false;
    };
  }, [pathname]);

  const signOut = async () => {
    await api('/api/session', { method: 'DELETE' });
    setMe(null);
    router.push('/');
    router.refresh();
  };

  return (
    <>
      <a href="/ladder" className="link-inline type-label" aria-current={pathname === '/ladder' ? 'page' : undefined}>
        Ladder
      </a>
      <a href="/audit" className="link-inline type-label" aria-current={pathname === '/audit' ? 'page' : undefined}>
        Purse calls
      </a>
      {me === undefined || me === null ? null : (
        <>
          <span className="type-label" data-testid="signed-in-as">
            {me.name}
          </span>
          <Button small onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      )}
    </>
  );
}
