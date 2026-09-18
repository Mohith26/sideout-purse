'use client';

import { useState } from 'react';

import { Button } from '../../../../../components/ui';

/** The organizer's retry of a Purse push or its confirmation, under the key minted at `agreed`; the page reloads to show where it got. */
export function RetryButton({ matchId }: { matchId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/matches/${matchId}/purse/retry`, { method: 'POST' });
      const body = (await response.json()) as { data?: { purse: { status: string; error?: { message: string } } }; error?: { message: string } };
      if (body.data === undefined) {
        setMessage(body.error?.message ?? `Refused (${response.status}).`);
        return;
      }
      setMessage(body.data.purse.error === undefined ? `Purse: ${body.data.purse.status.replace(/_/g, ' ')}.` : `Purse: ${body.data.purse.error.message}`);
      if (body.data.purse.status === 'confirmed') window.location.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => void retry()} disabled={busy}>
        {busy ? 'Retrying…' : 'Retry the Purse push'}
      </Button>
      {message === null ? null : <span className="text-[0.8125rem] text-text-secondary">{message}</span>}
    </div>
  );
}
