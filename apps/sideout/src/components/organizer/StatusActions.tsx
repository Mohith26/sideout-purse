'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ConfirmDialog, Icons, StatusPill, useToast } from '@sideout/ui';

import type { TournamentStatus } from '../../db/schema';
import { TOURNAMENT_TRANSITIONS } from '../../domain/state';
import { api } from '../../lib/api-client';
import { TOURNAMENT_STATUS_PILL } from '../status/pills';
import { Notice } from '../ui/Notice';

/**
 * Status transitions as the validator allows an organizer (`TOURNAMENT_TRANSITIONS`), sent
 * through `PATCH /api/admin/tournaments/:id`. Going live needs a draw; closing
 * (`→ awaiting_settlement`) is a plain step here, and settlement (`→ settled`) happens
 * only through the close flow against Purse's frozen preview. A destructive transition
 * asks first. The Purse mirror's outcome is reported, never fatal.
 */
type Target = Extract<TournamentStatus, 'registration_open' | 'registration_closed' | 'live' | 'awaiting_settlement' | 'cancelled'>;

const ACTION: Record<Target, { label: string; confirm: string | null; destructive: boolean; icon: 'arrowRight' | 'radio' | 'ban' | 'flag' }> = {
  registration_open: { label: 'Open registration', confirm: null, destructive: false, icon: 'arrowRight' },
  registration_closed: { label: 'Close registration', confirm: 'Close registration? No more teams can enter; you can then generate the draw. Reopening later discards any draw.', destructive: false, icon: 'arrowRight' },
  live: { label: 'Go live', confirm: 'Go live? Scores can be submitted from the sand, the Purse contest is locked, and the draw can no longer be replaced once a match starts.', destructive: false, icon: 'radio' },
  awaiting_settlement: { label: 'End play', confirm: 'End play? Every match must be complete. The tournament then waits for the close through Purse’s frozen preview.', destructive: false, icon: 'flag' },
  cancelled: { label: 'Cancel event', confirm: 'Cancel this event? This cannot be undone. The Purse contest is voided and every stake refunded; donations are not refunded automatically.', destructive: true, icon: 'ban' },
};

export function organizerTargets(status: TournamentStatus): Target[] {
  return (Object.entries(TOURNAMENT_TRANSITIONS[status]) as Array<[TournamentStatus, readonly string[]]>).filter(([, actors]) => actors.includes('organizer')).map(([to]) => to as Target);
}

type PatchResponse = { tournament: { status: TournamentStatus }; purse: { status: string; reason?: string; error?: { message: string } } | null };

export function StatusActions({ tournamentId, status, matchCount }: { tournamentId: string; status: TournamentStatus; matchCount: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purseNote, setPurseNote] = useState<string | null>(null);

  async function move(to: Target) {
    setBusy(true);
    setError(null);
    const result = await api<PatchResponse>(`/api/admin/tournaments/${tournamentId}`, { method: 'PATCH', body: { status: to } });
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const purse = result.data.purse;
    setPurseNote(purse === null ? null : purse.error !== undefined ? `Purse: ${purse.error.message}` : purse.reason !== undefined ? `Purse: ${purse.reason}` : `Purse: ${purse.status.replace(/_/g, ' ')}`);
    toast({ tone: 'success', title: `Now ${TOURNAMENT_STATUS_PILL[result.data.tournament.status].label.toLowerCase()}` });
    router.refresh();
  }

  const targets = organizerTargets(status);
  const pendingAction = pending === null ? null : ACTION[pending];

  return (
    <div className="space-y-3" data-testid="status-actions">
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-label text-text-tertiary">Now</span>
        <StatusPill spec={TOURNAMENT_STATUS_PILL[status]} />
      </div>
      {error === null ? null : (
        <Notice tone="error" title="The status did not change">
          {error}
        </Notice>
      )}
      {purseNote === null ? null : <p className="type-label text-text-tertiary">{purseNote}</p>}
      {targets.length === 0 ? <p className="text-text-tertiary">No further transitions from here.</p> : null}
      <div className="flex flex-wrap gap-2">
        {targets.map((to) => {
          const action = ACTION[to];
          const blocked = to === 'live' && matchCount === 0;
          const Icon = Icons[action.icon];
          return (
            <ActionButton key={to} variant={action.destructive ? 'danger' : 'secondary'} disabled={busy || blocked} title={blocked ? 'Generate the draw before going live.' : undefined} onClick={() => (action.confirm === null ? void move(to) : setPending(to))} iconStart={<Icon size={16} />}>
              {action.label}
            </ActionButton>
          );
        })}
        {status === 'awaiting_settlement' || status === 'settled' ? (
          <Link href={`/organizer/events/${tournamentId}/close`} className="so-button so-button--secondary">
            <Icons.flag size={16} />
            {status === 'settled' ? 'See the frozen preview' : 'Close through Purse'}
          </Link>
        ) : null}
      </div>
      {status === 'registration_closed' && matchCount === 0 ? <p className="type-label text-text-tertiary">Going live needs a draw; generate one below first.</p> : null}
      {status === 'awaiting_settlement' ? <p className="text-text-secondary">Play is over. Settlement happens in the close flow: Purse computes the payouts, you confirm the frozen preview’s hash.</p> : null}
      <ConfirmDialog
        open={pending !== null}
        title={pendingAction?.label ?? ''}
        body={pendingAction?.confirm ?? undefined}
        confirmLabel={pendingAction?.label ?? 'Confirm'}
        destructive={pendingAction?.destructive ?? false}
        busy={busy}
        onConfirm={() => (pending === null ? undefined : void move(pending))}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
