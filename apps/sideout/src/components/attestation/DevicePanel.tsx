'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ConfirmDialog, Icons } from '@sideout/ui';

import type { DeviceView } from '../../domain/attestation';
import { api, type ApiResult } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import { DataTable } from '../ui/DataTable';
import { AttestationMark } from './AttestationBadge';

/**
 * The organizer's view of every phone checked in for an event (spec section 12, item 1):
 * which team, whose, when, whether Purse holds the key too, and a revoke control. A
 * revocation refuses every scoreline that phone signed from now on, queued ones included,
 * and stays on the list as history; the player checks the phone in again if it comes
 * back. Revoking is confirmed, since it cannot be undone.
 */
export type DevicePanelRow = DeviceView & { teamName: string; memberName: string };

export type RevokeResponse = { device: DeviceView; revoked: boolean; mirror: { status: string; reason?: string } };

export function DevicePanel({ devices, timeZone, revoke }: { devices: DevicePanelRow[]; timeZone: string; revoke?: (deviceId: string) => Promise<ApiResult<RevokeResponse>> }) {
  const router = useRouter();
  const [pending, setPending] = useState<DevicePanelRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState(devices);
  const send = revoke ?? ((id: string) => api<RevokeResponse>(`/api/admin/devices/${id}/revoke`, { method: 'POST', body: { reason: 'Revoked by the organizer' } }));

  const onConfirm = async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    const result = await send(pending.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setRows((current) => current.map((d) => (d.id === pending.id ? { ...d, revokedAt: result.data.device.revokedAt, revokedReason: result.data.device.revokedReason } : d)));
    setPending(null);
    router.refresh();
  };

  if (rows.length === 0) return <p className="text-text-secondary">No phone has been checked in for this event yet. Players check theirs in from the register screen; scorelines from a checked-in phone arrive signed.</p>;

  const live = rows.filter((d) => d.revokedAt === null).length;
  return (
    <div className="space-y-3" data-testid="device-panel">
      <p className="text-text-secondary">
        {live} {live === 1 ? 'phone' : 'phones'} checked in. A scoreline signed by a checked-in phone is verified before it counts and is marked <AttestationMark attested /> on the match and in the dispute queue; a scoreline from any other phone is <AttestationMark attested={false} /> and counts on both teams’ agreement alone.
      </p>
      {error === null ? null : (
        <p role="alert" className="so-inline-alert">
          <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      <DataTable
        caption="Checked-in phones"
        rows={rows}
        getRowKey={(d) => d.id}
        rowAttributes={(d) => ({ 'data-device': d.id, 'data-revoked': d.revokedAt === null ? 'false' : 'true' })}
        rowClassName={(d) => (d.revokedAt === null ? undefined : 'text-text-tertiary')}
        columns={[
          { key: 'team', header: 'Team', render: (d) => d.teamName },
          { key: 'player', header: 'Player', render: (d) => d.memberName },
          { key: 'key', header: 'Key', render: (d) => <span className="font-mono">{d.keyId.slice(0, 8)}…</span> },
          { key: 'when', header: 'Checked in', render: (d) => <span className="tabular whitespace-nowrap">{d.revokedAt === null ? formatDateTime(d.registeredAt, timeZone) : `Revoked ${formatDateTime(d.revokedAt, timeZone)}`}</span> },
          { key: 'purse', header: 'Purse', render: (d) => (d.mirrored ? 'holds the key' : 'not yet'), hideBelowMd: true },
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'end',
            render: (d) =>
              d.revokedAt === null ? (
                <ActionButton variant="ghost" onClick={() => setPending(d)} iconStart={<Icons.shieldOff size={14} />}>
                  Revoke
                </ActionButton>
              ) : null,
          },
        ]}
      />
      <ConfirmDialog
        open={pending !== null}
        title="Revoke this phone?"
        body={pending === null ? '' : `${pending.memberName}’s phone will no longer sign scorelines for ${pending.teamName}. Anything it signed and has not yet sent will be refused when it arrives; the player can check the phone in again. This cannot be undone.`}
        confirmLabel={busy ? 'Revoking…' : 'Revoke phone'}
        destructive
        busy={busy}
        onConfirm={() => void onConfirm()}
        onCancel={() => {
          if (!busy) setPending(null);
        }}
      />
    </div>
  );
}
