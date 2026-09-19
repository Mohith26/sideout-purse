'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionButton, Icons, StatusPill } from '@sideout/ui';

import type { DeviceView } from '../../domain/attestation';
import { api } from '../../lib/api-client';
import { canSign, currentDeviceKey, ensureDeviceKey } from '../../lib/attestation/device';
import { formatDateTime } from '../../lib/format';
import { ATTESTATION_PILL } from './AttestationBadge';

/**
 * The check-in card (spec section 12, item 1): the phones checked in for the team, and a
 * button that checks this one in. The key pair is generated here, on the phone, the first
 * time; the public half goes to `POST /api/teams/:id/devices` and the private half never
 * leaves the browser's key store. A phone whose check-in the organizer revoked, or a new
 * phone, checks in again the same way and becomes a new device; the old one stays on the
 * list as revoked so the history is visible.
 */
export type DeviceCheckInProps = {
  teamId: string;
  teamName: string;
  viewerUserId: string;
  members: ReadonlyArray<{ userId: string; displayName: string }>;
  devices: DeviceView[];
  /** Whether a check-in is possible now (the team holds a place, the event is not over). */
  open: boolean;
  timeZone: string;
  /** Test hook: the request to make instead of `POST /api/teams/:id/devices`. */
  register?: (teamId: string, publicKey: unknown) => Promise<{ ok: boolean; message?: string; devices?: DeviceView[] }>;
};

type Phone = { kind: 'loading' } | { kind: 'unsupported' } | { kind: 'ready'; keyId: string | null };

type Response = { device: DeviceView; created: boolean; mirror: { status: string; reason?: string }; devices: DeviceView[] };

export function phoneStatus(phone: Phone, devices: readonly DeviceView[]): 'loading' | 'unsupported' | 'checked_in' | 'revoked' | 'not_checked_in' {
  if (phone.kind === 'loading') return 'loading';
  if (phone.kind === 'unsupported') return 'unsupported';
  if (phone.keyId === null) return 'not_checked_in';
  const mine = devices.filter((d) => d.keyId === phone.keyId);
  if (mine.some((d) => d.revokedAt === null)) return 'checked_in';
  if (mine.length > 0) return 'revoked';
  return 'not_checked_in';
}

export function DeviceCheckIn({ teamId, teamName, viewerUserId, members, devices: initial, open, timeZone, register }: DeviceCheckInProps) {
  const router = useRouter();
  const [phone, setPhone] = useState<Phone>({ kind: 'loading' });
  const [devices, setDevices] = useState<DeviceView[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!canSign()) {
        setPhone({ kind: 'unsupported' });
        return;
      }
      void currentDeviceKey().then((key) => {
        if (!cancelled) setPhone({ kind: 'ready', keyId: key?.keyId ?? null });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = phoneStatus(phone, devices);
  const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.displayName ?? 'A teammate';

  const onCheckIn = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const key = await ensureDeviceKey();
      const send =
        register ??
        (async (id: string, publicKey: unknown) => {
          const result = await api<Response>(`/api/teams/${id}/devices`, { method: 'POST', body: { publicKey } });
          if (!result.ok) return { ok: false, message: result.error.message };
          const mirror = result.data.mirror;
          return { ok: true, devices: result.data.devices, ...(mirror.status === 'mirrored' ? {} : { message: mirror.reason ?? 'Purse has not been told about this phone yet.' }) };
        });
      const outcome = await send(teamId, key.publicKey);
      if (!outcome.ok) {
        setError(outcome.message ?? 'Could not check this phone in.');
        return;
      }
      setPhone({ kind: 'ready', keyId: key.keyId });
      if (outcome.devices !== undefined) setDevices(outcome.devices);
      if (outcome.message !== undefined) setNote(outcome.message);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check this phone in.');
    } finally {
      setBusy(false);
    }
  };

  const live = devices.filter((d) => d.revokedAt === null);
  const revoked = devices.filter((d) => d.revokedAt !== null);

  return (
    <div className="space-y-3" data-testid="device-check-in" data-status={status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-text-primary">
          <Icons.smartphone size={18} className="text-text-tertiary" />
          {status === 'checked_in' ? 'This phone is checked in' : status === 'revoked' ? 'This phone’s check-in was revoked' : status === 'unsupported' ? 'This browser cannot sign' : status === 'loading' ? 'Checking this phone…' : 'This phone is not checked in'}
        </span>
        {status === 'checked_in' ? <StatusPill spec={ATTESTATION_PILL.signed} size="sm" /> : status === 'loading' || status === 'unsupported' ? null : <StatusPill spec={ATTESTATION_PILL.unsigned} size="sm" />}
      </div>
      <p className="text-text-secondary">
        {status === 'checked_in'
          ? `Scorelines you submit from this phone are signed with a key that never leaves it, and verified against the check-in before they count. ${teamName} can check in more than one phone.`
          : status === 'unsupported'
            ? 'Signing needs a secure page (https) and a browser with Web Crypto. Scorelines from this browser are accepted unsigned.'
            : status === 'revoked'
              ? 'The organizer revoked this phone. Check it in again to sign scorelines from it; the old check-in stays on record.'
              : 'Check this phone in so the scorelines it submits are signed with a key made here and verified against the check-in. Unsigned scorelines are still accepted; a signed one proves the phone it came from.'}
      </p>
      {open && status !== 'checked_in' && status !== 'unsupported' && status !== 'loading' ? (
        <ActionButton variant="primary" onClick={() => void onCheckIn()} disabled={busy} aria-busy={busy} iconStart={<Icons.smartphone size={18} />}>
          {busy ? 'Checking in…' : 'Check in this phone'}
        </ActionButton>
      ) : null}
      {!open && status === 'not_checked_in' ? <p className="type-label text-text-tertiary">Check-in opens once the team is registered and closes when play ends.</p> : null}
      {error === null ? null : (
        <p role="alert" className="so-inline-alert">
          <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {note === null ? null : <p className="type-label text-text-tertiary">{note}</p>}
      {live.length + revoked.length > 0 ? (
        <ul className="divide-y divide-border-subtle rounded-card border border-border-subtle" aria-label={`Phones checked in for ${teamName}`} data-testid="device-list">
          {[...live, ...revoked].map((d) => {
            const mine = phone.kind === 'ready' && phone.keyId === d.keyId;
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-device={d.id} data-revoked={d.revokedAt === null ? 'false' : 'true'}>
                <span className="min-w-0 text-text-primary">
                  {nameOf(d.userId)}
                  {d.userId === viewerUserId ? ' (you)' : ''}
                  {mine ? <span className="ml-2 type-label text-surf">this phone</span> : null}
                </span>
                <span className="tabular type-label text-text-tertiary">
                  {d.revokedAt === null ? `checked in ${formatDateTime(d.registeredAt, timeZone)}` : `revoked ${formatDateTime(d.revokedAt, timeZone)}`}
                  {d.revokedAt === null && !d.mirrored ? ' · not yet with Purse' : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
