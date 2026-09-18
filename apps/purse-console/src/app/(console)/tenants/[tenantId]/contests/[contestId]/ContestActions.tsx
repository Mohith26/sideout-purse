'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@sideout/ui';
import type { ApiError, ContestResource } from '@purse/types';

import { ErrorNotice } from '../../../../../../components/ErrorNotice';
import { api } from '../../../../../../lib/client';

/** The plain transitions and void, each with a confirm step; settlement has its own flow. */
const NEXT: Partial<Record<ContestResource['state'], Array<{ to: 'open' | 'locked' | 'in_progress' | 'awaiting_settlement' | 'cancelled'; label: string }>>> = {
  draft: [
    { to: 'open', label: 'Open' },
    { to: 'cancelled', label: 'Cancel' },
  ],
  open: [{ to: 'locked', label: 'Lock' }],
  locked: [{ to: 'in_progress', label: 'Start' }],
  in_progress: [{ to: 'awaiting_settlement', label: 'Finish (declare results complete)' }],
};

const VOIDABLE = new Set<ContestResource['state']>(['open', 'locked', 'in_progress', 'awaiting_settlement']);

export function ContestActions({ tenantId, contest }: { tenantId: string; contest: ContestResource }) {
  const router = useRouter();
  const [pending, setPending] = useState<{ kind: 'transition'; to: string; label: string } | { kind: 'void' } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const transitions = NEXT[contest.state] ?? [];
  if (transitions.length === 0 && !VOIDABLE.has(contest.state)) return null;

  async function apply() {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    const body = reason.trim() === '' ? {} : { reason: reason.trim() };
    const res = pending.kind === 'void' ? await api.post(`/tenants/${tenantId}/contests/${contest.id}/void`, body) : await api.post(`/tenants/${tenantId}/contests/${contest.id}/transition`, { to: pending.to, ...body });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPending(null);
    setReason('');
    router.refresh();
  }

  return (
    <div className="stack">
      {pending === null ? (
        <div className="so-actions">
          {transitions.map((each) => (
            <Button key={each.to} small onClick={() => setPending({ kind: 'transition', to: each.to, label: each.label })}>
              {each.label}
            </Button>
          ))}
          {VOIDABLE.has(contest.state) ? (
            <Button small variant="danger" onClick={() => setPending({ kind: 'void' })}>
              Void (refund everyone)
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <Field id="contest-action-reason" label="Reason" hint="Optional; recorded in the audit log.">
            <Input id="contest-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          </Field>
          {error === null ? null : <ErrorNotice error={error} />}
          <div className="so-actions">
            <Button variant={pending.kind === 'void' ? 'danger' : 'primary'} disabled={busy} onClick={apply}>
              {pending.kind === 'void' ? 'Confirm void' : `Confirm: ${pending.label}`}
            </Button>
            <Button disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
