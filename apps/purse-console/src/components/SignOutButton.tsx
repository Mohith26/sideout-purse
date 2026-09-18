'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@sideout/ui';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      small
      disabled={busy}
      onClick={() => {
        setBusy(true);
        fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .catch(() => undefined)
          .finally(() => {
            router.push('/login');
            router.refresh();
          });
      }}
    >
      Sign out
    </Button>
  );
}
