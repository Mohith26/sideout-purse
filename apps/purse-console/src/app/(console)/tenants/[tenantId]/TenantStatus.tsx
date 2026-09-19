'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@sideout/ui';
import type { ApiError, TenantResource, TenantStatus as Status } from '@purse/types';

import { ErrorNotice } from '../../../../components/ErrorNotice';
import { api } from '../../../../lib/client';

/** Suspend or reinstate, with a reason and an explicit confirm; admin only. */
export function TenantStatus({ tenantId, status, admin }: { tenantId: string; status: Status; admin: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (status === 'retired') return <p className="so-field__hint">This sandbox expired and cannot be reinstated.</p>;
  if (!admin) return <p className="so-field__hint">Only an admin can suspend or reinstate a tenant.</p>;
  const next: Status = status === 'active' ? 'suspended' : 'active';

  async function apply() {
    setBusy(true);
    setError(null);
    const res = await api.post<TenantResource>(`/tenants/${tenantId}/status`, { status: next, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setConfirming(false);
    setReason('');
    router.refresh();
  }

  if (!confirming) {
    return (
      <div>
        <Button variant={next === 'suspended' ? 'danger' : 'secondary'} small onClick={() => setConfirming(true)}>
          {next === 'suspended' ? 'Suspend tenant' : 'Reinstate tenant'}
        </Button>
      </div>
    );
  }
  return (
    <div className="stack">
      <Field id="tenant-status-reason" label="Reason" hint="Recorded in the audit log.">
        <Input id="tenant-status-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
      </Field>
      {error === null ? null : <ErrorNotice error={error} />}
      <div className="so-actions">
        <Button variant={next === 'suspended' ? 'danger' : 'primary'} disabled={busy} onClick={apply}>
          {next === 'suspended' ? 'Confirm suspension' : 'Confirm reinstatement'}
        </Button>
        <Button disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
