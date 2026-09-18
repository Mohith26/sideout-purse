'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Purse, type PurseEvents } from '@purse/sdk';

import { Button, Chip, Notice } from '../../../../components/ui';

/**
 * Step 2 of registration (spec 5.3, "Register"): the Purse contest entry, in Purse's own
 * iframe on Purse's origin. The page links the player's Purse account, mints a
 * single-use embed token server to server, and mounts the SDK's `entry` flow with it;
 * when the flow completes, the server reads the contest's entrants back and records who
 * is in. The donation was step 1 and is shown apart, on its own surface: nobody should
 * think their donation is a stake.
 */
type Player = { userId: string; displayName: string; role: string; linked: boolean; entered: boolean };
type Grant = { token: string; contestId: string | null; purseOrigin: string; publishableKey: string; tenantId: string };

export function EntryStep({ teamId, tournamentSlug, initialPlayers, viewerUserId }: { teamId: string; tournamentSlug: string; initialPlayers: Player[]; viewerUserId: string }) {
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  const [phase, setPhase] = useState<'idle' | 'linking' | 'mounting' | 'mounted' | 'verifying' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const purseRef = useRef<Purse | null>(null);
  const router = useRouter();
  const me = players.find((p) => p.userId === viewerUserId);

  const verify = async () => {
    setPhase('verifying');
    const response = await fetch(`/api/teams/${teamId}/purse/entries`, { method: 'POST' });
    const body = (await response.json()) as { data?: { players: Player[]; complete: boolean }; error?: { message: string } };
    if (body.data === undefined) {
      setError(body.error?.message ?? `Could not verify the entry (${response.status}).`);
      setPhase('mounted');
      return;
    }
    setPlayers(body.data.players);
    setPhase('done');
    // The header's count is server-rendered; refresh it.
    router.refresh();
  };

  const start = async () => {
    setError(null);
    try {
      setPhase('linking');
      const linked = await fetch('/api/me/purse/link', { method: 'POST' });
      if (!linked.ok) {
        const body = (await linked.json()) as { error?: { message: string } };
        throw new Error(body.error?.message ?? `Could not link your Purse account (${linked.status}).`);
      }
      setPhase('mounting');
      const minted = await fetch('/api/me/purse/embed-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow: 'entry', tournamentSlug }) });
      const body = (await minted.json()) as { data?: Grant; error?: { message: string } };
      const contestId = body.data?.contestId ?? null;
      if (body.data === undefined || contestId === null) throw new Error(body.error?.message ?? 'Could not start the entry flow.');
      const grant = { ...body.data, contestId };
      const purse = await Purse.init({ publishableKey: grant.publishableKey, tenantId: grant.tenantId, purseOrigin: grant.purseOrigin, theme: { accent: '#D7FF3E', surface: '#101216', radius: 10, font: 'Instrument Sans' } });
      purseRef.current?.unmount();
      purseRef.current = purse;
      purse.on('flow:complete', (result: PurseEvents['flow:complete']) => {
        if (result.flow === 'entry') void verify();
      });
      purse.on('error', (e: PurseEvents['error']) => {
        if (e.type === 'not_eligible') setError(`Purse declined the entry: ${(e.detail?.['reasons'] as string[] | undefined)?.join(', ') ?? e.message}`);
        else setError(`${e.message} (${e.code})`);
      });
      if (slot.current === null) throw new Error('The entry slot is missing.');
      await purse.mount(slot.current, { flow: 'entry', embedToken: grant.token, contestId: grant.contestId, initialHeight: 420 });
      setPhase('mounted');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('idle');
    }
  };

  useEffect(() => () => purseRef.current?.unmount(), []);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {players.map((p) => (
          <li key={p.userId} className="flex items-center justify-between gap-2 text-body text-text-primary">
            <span>
              {p.displayName} <span className="text-text-tertiary">· {p.role}</span>
            </span>
            <Chip tone={p.entered ? 'positive' : 'neutral'}>{p.entered ? 'entered' : p.linked ? 'not entered yet' : 'not linked'}</Chip>
          </li>
        ))}
      </ul>
      {me?.entered === true ? (
        <Notice tone="positive" title="You are in">
          {players.every((p) => p.entered) ? 'Both players have entered the contest.' : 'Your partner still needs to enter from their own account.'}
        </Notice>
      ) : (
        <>
          {phase === 'idle' ? (
            <div>
              <Button primary onClick={() => void start()}>
                Enter the contest on Purse
              </Button>
            </div>
          ) : null}
          {phase === 'linking' ? <p className="text-body text-text-secondary">Linking your Purse account…</p> : null}
          {phase === 'mounting' ? <p className="text-body text-text-secondary">Opening Purse…</p> : null}
          <div ref={slot} className={phase === 'mounted' || phase === 'mounting' || phase === 'verifying' ? 'block' : 'hidden'} aria-live="polite" />
          {phase === 'mounted' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void verify()}>I have confirmed my entry</Button>
              <span className="text-[0.8125rem] text-text-tertiary">Sideout reads the contest back from Purse; it never trusts the page.</span>
            </div>
          ) : null}
          {phase === 'verifying' ? <p className="text-body text-text-secondary">Reading the contest back from Purse…</p> : null}
          {phase === 'done' ? <Notice tone="warning" title="Not entered yet">Purse does not hold your entry yet. Confirm in the Purse frame, then check again.</Notice> : null}
        </>
      )}
      {error === null ? null : <Notice tone="error" title="Entry not made">{error}</Notice>}
    </div>
  );
}
