'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Icons, useToast } from '@sideout/ui';

import { api } from '../../lib/api-client';
import { clearCachedPages } from '../offline/ServiceWorkerRegistration';

export function SignOutButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <ActionButton
      variant="ghost"
      disabled={busy}
      aria-busy={busy}
      iconStart={<Icons.logOut size={16} />}
      onClick={async () => {
        setBusy(true);
        const result = await api<{ signedOut: boolean }>('/api/auth/logout', { method: 'POST', body: {} });
        setBusy(false);
        if (!result.ok) {
          toast({ tone: 'error', title: 'Could not sign out', body: result.error.message });
          return;
        }
        // The offline cache held this player's pages; a shared phone must not keep them.
        clearCachedPages();
        router.replace('/');
        router.refresh();
      }}
    >
      Sign out
    </ActionButton>
  );
}
