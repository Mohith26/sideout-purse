'use client';

import { useState } from 'react';

import { judgeMatch, type SetScore } from '../../../domain/scoreline';
import { Button, Notice } from '../../../components/ui';

/** The organizer's authoritative scoreline for a disputed match, team A's points first, judged as it is typed. */
export function ResolveForm({ matchId, bestOf, teamA, teamB, initial }: { matchId: string; bestOf: 1 | 3; teamA: string; teamB: string; initial: SetScore[] }) {
  const [sets, setSets] = useState<SetScore[]>(initial.length > 0 ? initial : [{ setNumber: 1, teamAPoints: 0, teamBPoints: 0 }]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'error'; text: string } | null>(null);
  const verdict = judgeMatch(sets, bestOf);

  const edit = (index: number, key: 'teamAPoints' | 'teamBPoints', value: string) => {
    const n = Math.max(0, Math.min(99, Number.parseInt(value, 10) || 0));
    setSets((current) => current.map((s, i) => (i === index ? { ...s, [key]: n } : s)));
  };
  const resolve = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/matches/${matchId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sets }) });
      const body = (await response.json()) as { data?: { consensus: { state: string }; purse: { status: string; error?: { message: string } } }; error?: { message: string } };
      if (body.data === undefined) {
        setMessage({ tone: 'error', text: body.error?.message ?? `Refused (${response.status}).` });
        return;
      }
      const purse = body.data.purse.error === undefined ? `Purse: ${body.data.purse.status.replace(/_/g, ' ')}.` : `Purse: ${body.data.purse.error.message}`;
      setMessage({ tone: 'positive', text: `Resolved and final (${body.data.consensus.state.replace(/_/g, ' ')}). ${purse}` });
    } catch (caught) {
      setMessage({ tone: 'error', text: caught instanceof Error ? caught.message : 'The resolution failed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {sets.map((set, index) => (
        <div key={set.setNumber} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
          <span className="label text-text-secondary">Set {set.setNumber}</span>
          <label className="flex flex-col gap-1 text-[0.8125rem] text-text-tertiary">
            {teamA}
            <input type="number" inputMode="numeric" min={0} max={99} value={set.teamAPoints} onChange={(e) => edit(index, 'teamAPoints', e.target.value)} className="tabular min-h-11 rounded-input border border-border-strong bg-bg-inset px-3 text-body text-text-primary" />
          </label>
          <label className="flex flex-col gap-1 text-[0.8125rem] text-text-tertiary">
            {teamB}
            <input type="number" inputMode="numeric" min={0} max={99} value={set.teamBPoints} onChange={(e) => edit(index, 'teamBPoints', e.target.value)} className="tabular min-h-11 rounded-input border border-border-strong bg-bg-inset px-3 text-body text-text-primary" />
          </label>
        </div>
      ))}
      {bestOf === 3 ? (
        <div className="flex gap-2">
          <Button onClick={() => setSets((c) => (c.length < 3 ? [...c, { setNumber: c.length + 1, teamAPoints: 0, teamBPoints: 0 }] : c))} disabled={sets.length >= 3}>
            Add a set
          </Button>
          <Button onClick={() => setSets((c) => (c.length > 1 ? c.slice(0, -1) : c))} disabled={sets.length <= 1}>
            Remove the last set
          </Button>
        </div>
      ) : null}
      <p className={`text-body ${verdict.legal ? 'text-surf' : 'text-text-secondary'}`}>{verdict.legal ? `Legal: ${verdict.winner === 'a' ? teamA : teamB} wins.` : verdict.reason}</p>
      {message === null ? null : <Notice tone={message.tone} title={message.tone === 'positive' ? 'Resolved' : 'Not resolved'}>{message.text}</Notice>}
      <Button primary onClick={() => void resolve()} disabled={busy || !verdict.legal || message?.tone === 'positive'}>
        {busy ? 'Resolving…' : 'Resolve with this scoreline'}
      </Button>
    </div>
  );
}
