'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Icons } from '@sideout/ui';

import { api } from '../../lib/api-client';

/** The organizer's retry of a Purse push or its confirmation, under the key minted at `agreed`; the page re-reads to show where it got. */
export function RetryPushButton({ matchId }: { matchId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    const result = await api<{ purse: { status: string; error?: { message: string } } }>(`/api/admin/matches/${matchId}/purse/retry`, { method: 'POST', body: {} });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setMessage(result.data.purse.error === undefined ? `Purse: ${result.data.purse.status.replace(/_/g, ' ')}.` : `Purse: ${result.data.purse.error.message}`);
    router.refresh();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionButton variant="secondary" onClick={() => void retry()} disabled={busy} aria-busy={busy} iconStart={<Icons.arrowRight size={16} />}>
        {busy ? 'Retrying…' : 'Retry the Purse push'}
      </ActionButton>
      {message === null ? null : (
        <span role="status" className="type-label text-text-secondary">
          {message}
        </span>
      )}
    </div>
  );
}
