'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionButton, Icons, StatusPill, type PillSpec } from '@sideout/ui';

import { api } from '../../lib/api-client';
import { Notice } from '../ui/Notice';
import { PurseNotice } from '../purse/PurseNotice';
import { usePurse } from '../purse/PurseGate';

/**
 * Step 2 of registration (spec 5.3, "Register"): the Purse contest entry, in Purse's own
 * frame on Purse's origin, mounted through the gate into this card's slot so it sits on
 * the visibly distinct surface. When the flow completes, the server reads the contest's
 * entrants back (`POST /api/teams/:id/purse/entries`) and records who is in; the page
 * never trusts the frame. A refusal is one of the sealed eligibility variants, rendered
 * as a plain state with the one thing the player can do.
 */
export type EntryPlayer = { userId: string; displayName: string; role: string; linked: boolean; entered: boolean };

const ENTERED: PillSpec = { label: 'Entered', tone: 'success', icon: 'circleCheck' };
const NOT_YET: PillSpec = { label: 'Not entered yet', tone: 'muted', icon: 'circleDashed' };
const NOT_LINKED: PillSpec = { label: 'Not linked', tone: 'muted', icon: 'circleDashed' };

export function PurseEntryStep({ teamId, tournamentSlug, initialPlayers, viewerUserId, supportHref, entriesOpen }: { teamId: string; tournamentSlug: string; initialPlayers: EntryPlayer[]; viewerUserId: string; supportHref: string; entriesOpen: boolean }) {
  const purse = usePurse();
  const router = useRouter();
  const [players, setPlayers] = useState<EntryPlayer[]>(initialPlayers);
  const [phase, setPhase] = useState<'idle' | 'open' | 'verifying' | 'not_found'>('idle');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const me = players.find((p) => p.userId === viewerUserId);

  useEffect(() => {
    purse.registerSlot(slot.current);
    return () => purse.registerSlot(null);
  }, [purse]);

  const verify = useCallback(async () => {
    setPhase('verifying');
    setVerifyError(null);
    const result = await api<{ players: EntryPlayer[]; complete: boolean }>(`/api/teams/${teamId}/purse/entries`, { method: 'POST', body: {} });
    if (!result.ok) {
      setVerifyError(result.error.message);
      setPhase('idle');
      return;
    }
    setPlayers(result.data.players);
    setPhase(result.data.players.find((p) => p.userId === viewerUserId)?.entered === true ? 'idle' : 'not_found');
    router.refresh();
  }, [teamId, viewerUserId, router]);

  const start = async () => {
    setPhase('open');
    const outcome = await purse.open('entry', { tournamentSlug });
    if (outcome.ok && outcome.result?.flow === 'entry') {
      await verify();
      return;
    }
    setPhase('idle');
  };

  return (
    <div className="flex flex-col gap-3" data-testid="purse-entry-step" aria-busy={phase === 'verifying'}>
      <ul className="flex flex-col gap-1">
        {players.map((p) => (
          <li key={p.userId} className="flex items-center justify-between gap-2 text-text-primary">
            <span>
              {p.displayName} <span className="text-text-tertiary">· {p.role}</span>
              {p.userId === viewerUserId ? <span className="text-text-tertiary"> · you</span> : null}
            </span>
            <StatusPill spec={p.entered ? ENTERED : p.linked ? NOT_YET : NOT_LINKED} size="sm" />
          </li>
        ))}
      </ul>
      {me?.entered === true ? (
        <Notice tone="success" title="You are in" testId="entry-done">
          {players.every((p) => p.entered) ? 'Both players have entered the contest.' : 'Your partner still needs to enter from their own account.'}
        </Notice>
      ) : !entriesOpen ? (
        <Notice tone="info" title="Entries are closed">
          The contest no longer takes entries.
        </Notice>
      ) : purse.config === null ? (
        <Notice tone="attention" title="Purse is not configured on this server">
          The entry flow needs the Purse publishable key; ask the organizer.
        </Notice>
      ) : (
        <>
          {phase === 'idle' ? (
            <div>
              <ActionButton variant="primary" large disabled={purse.busy} onClick={() => void start()} iconStart={<Icons.shieldCheck size={18} />}>
                Enter the contest on Purse
              </ActionButton>
            </div>
          ) : null}
          <div ref={slot} className={phase === 'open' ? 'rounded-card border border-volt/40 bg-bg-inset p-2' : 'hidden'} aria-live="polite" data-testid="entry-slot" />
          {phase === 'open' ? (
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton variant="secondary" onClick={() => void verify()}>
                I have confirmed my entry
              </ActionButton>
              <span className="type-label text-text-tertiary">Sideout reads the contest back from Purse; it never trusts the page.</span>
            </div>
          ) : null}
          {phase === 'verifying' ? <p className="text-text-secondary">Reading the contest back from Purse…</p> : null}
          {phase === 'not_found' ? (
            <Notice tone="attention" title="Not entered yet">
              Purse does not hold your entry yet. Confirm in the Purse frame, then check again.
            </Notice>
          ) : null}
        </>
      )}
      {verifyError === null ? null : (
        <Notice tone="error" title="Could not read the contest back">
          {verifyError}
        </Notice>
      )}
      {purse.failure === null ? null : <PurseNotice state={purse.failure} supportHref={supportHref} onRetry={() => void start()} />}
    </div>
  );
}
