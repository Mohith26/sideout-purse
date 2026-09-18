'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ConfirmDialog, Icons, useToast } from '@sideout/ui';

import { api } from '../../lib/api-client';

/**
 * Quick forfeit from the live board: pick which side forfeits, confirm, and
 * `POST /api/admin/matches/:id/forfeit` advances the other. The board re-renders from
 * rows; nothing is assumed about the outcome here.
 */
export function ForfeitControl({ matchId, teamA, teamB }: { matchId: string; teamA: { id: string; name: string }; teamB: { id: string; name: string } }) {
  const router = useRouter();
  const { toast } = useToast();
  const [choice, setChoice] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const winner = choice === null ? null : choice.id === teamA.id ? teamB : teamA;
  return (
    <div className="flex flex-wrap gap-1">
      {[teamA, teamB].map((team) => (
        <ActionButton key={team.id} variant="ghost" disabled={busy} onClick={() => setChoice(team)} iconStart={<Icons.ban size={14} />} aria-label={`${team.name} forfeits`}>
          {team.name.split('/')[0]?.trim() ?? team.name} forfeits
        </ActionButton>
      ))}
      <ConfirmDialog
        open={choice !== null}
        title={choice === null ? '' : `${choice.name} forfeits?`}
        body={winner === null ? undefined : `${winner.name} is recorded as the winner and advances if this match feeds another. The result is attributed to you in the audit log.`}
        confirmLabel="Record forfeit"
        destructive
        busy={busy}
        onCancel={() => setChoice(null)}
        onConfirm={async () => {
          if (choice === null) return;
          setBusy(true);
          const result = await api<unknown>(`/api/admin/matches/${matchId}/forfeit`, { method: 'POST', body: { forfeitingTeamId: choice.id } });
          setBusy(false);
          setChoice(null);
          if (!result.ok) {
            toast({ tone: 'error', title: 'Forfeit not recorded', body: result.error.message });
            return;
          }
          toast({ tone: 'success', title: 'Forfeit recorded', ...(winner === null ? {} : { body: `${winner.name} advances.` }) });
          router.refresh();
        }}
      />
    </div>
  );
}
