'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Notice } from '@sideout/ui';
import type { ApiError, RulesetResource } from '@purse/types';

import { ErrorNotice } from '../../../../components/ErrorNotice';
import { api } from '../../../../lib/client';

export function ActivateRuleset({ version, active, admin }: { version: string; active: boolean; admin: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (active) return <Notice tone="positive" title="Active">Every new contest pins this version; entries to a contest are judged under the version pinned at its creation.</Notice>;
  if (!admin) return <p className="so-field__hint">Only an admin can activate a version.</p>;

  async function activate() {
    setBusy(true);
    setError(null);
    const res = await api.post<RulesetResource>(`/rulesets/${version}/activate`, {});
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setConfirming(false);
    router.refresh();
  }

  return (
    <div className="stack">
      {error === null ? null : <ErrorNotice error={error} />}
      {confirming ? (
        <>
          <Notice tone="warning" title={`Activate ${version}?`}>
            The currently active version is deactivated in the same transaction; contests created from now on pin {version}. The change is audited under your operator id.
          </Notice>
          <div className="so-actions">
            <Button variant="primary" disabled={busy} onClick={activate}>
              Confirm activation
            </Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button variant="primary" onClick={() => setConfirming(true)}>
            Activate this version
          </Button>
        </div>
      )}
    </div>
  );
}
