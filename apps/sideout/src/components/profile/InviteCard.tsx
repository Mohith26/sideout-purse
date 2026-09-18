'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, StatusPill, useToast } from '@sideout/ui';

import type { TournamentStatus } from '../../db/schema';
import { api } from '../../lib/api-client';
import { TOURNAMENT_STATUS_PILL } from '../status/pills';
import { Notice } from '../ui/Notice';

export type InviteView = { teamId: string; teamName: string; captain: string; tournament: { id: string; slug: string; name: string; status: string } };

/** One pending partner invite with its accept action (`POST /api/teams/:id/join`). Only one card on a screen is the volt primary. */
export function InviteCard({ invite, primary = false }: { invite: InviteView; primary?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = invite.tournament.status === 'registration_open';
  const status = invite.tournament.status as TournamentStatus;
  return (
    <article className="surface-raised flex flex-col gap-3 rounded-card p-4 md:flex-row md:items-center md:justify-between" data-testid="invite-card">
      <div className="min-w-0">
        <p className="font-medium text-text-primary">
          {invite.captain} invited you to play as “{invite.teamName}”
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-secondary">
          <Link href={`/t/${invite.tournament.slug}`} className="target inline-flex items-center hover:text-text-primary">
            {invite.tournament.name}
          </Link>
          <StatusPill spec={TOURNAMENT_STATUS_PILL[status]} size="sm" />
        </p>
        {error === null ? null : (
          <Notice tone="error" className="mt-3">
            {error}
          </Notice>
        )}
      </div>
      <ActionButton
        variant={primary ? 'primary' : 'secondary'}
        disabled={busy || !open}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await api<unknown>(`/api/teams/${invite.teamId}/join`, { method: 'POST', body: {} });
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          toast({ tone: 'success', title: `You are on ${invite.teamName}`, body: 'Your captain registers the team to enter the event.' });
          router.push(`/t/${invite.tournament.slug}/register`);
          router.refresh();
        }}
      >
        {open ? 'Accept invite' : 'Registration closed'}
      </ActionButton>
    </article>
  );
}
