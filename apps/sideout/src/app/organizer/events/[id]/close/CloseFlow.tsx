'use client';

import { useState } from 'react';

import { Button, Chip, Label, Notice, Pre } from '../../../../../components/ui';

/**
 * The two-step close (spec 4.7, 4.10): fetch Purse's frozen preview and show it with its
 * payout hash, then confirm the close with that exact hash. A stale preview is refused by
 * Purse, which the second step reports; the organizer then fetches a fresh one.
 */
type Preview = {
  payoutHash: string;
  escrowTotal: string;
  contestState: string;
  previewedAt: string;
  standings: Array<{ teamId: string; teamName: string; placement: number; players: Array<{ userId: string; displayName: string; purseUserId: string | null }> }>;
  payouts: Array<{ userId: string; placement: number; payout: string }>;
  entries: Array<{ userId: string; score: number | null; attemptFinished: boolean }>;
};

type Closed = { status: string; replayed: boolean; settlement: { contestState: string; payoutHash: string; results: Array<{ userId: string; placement: number; payoutAmount: string }> } };

export function CloseFlow({ tournamentId, initial }: { tournamentId: string; initial: Preview | null }) {
  const [preview, setPreview] = useState<Preview | null>(initial);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [busy, setBusy] = useState<'preview' | 'close' | null>(null);
  const [error, setError] = useState<{ message: string; detail?: unknown } | null>(null);

  const fetchPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const response = await fetch(`/api/admin/tournaments/${tournamentId}/close/preview`);
      const body = (await response.json()) as { data?: Preview; error?: { message: string; detail?: unknown } };
      if (body.data === undefined) {
        setPreview(null);
        setError(body.error === undefined ? { message: `Refused (${response.status}).` } : { message: body.error.message, detail: body.error.detail });
        return;
      }
      setPreview(body.data);
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (preview === null) return;
    setBusy('close');
    setError(null);
    try {
      const response = await fetch(`/api/admin/tournaments/${tournamentId}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payoutHash: preview.payoutHash }) });
      const body = (await response.json()) as { data?: Closed; error?: { code: string; message: string; detail?: unknown } };
      if (body.data === undefined) {
        if (body.error?.code === 'preview_hash_mismatch') setPreview(null);
        setError(body.error === undefined ? { message: `Refused (${response.status}).` } : { message: body.error.message, detail: body.error.detail });
        return;
      }
      setClosed(body.data);
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (userId: string): string => {
    for (const team of preview?.standings ?? []) {
      const player = team.players.find((p) => p.purseUserId === userId);
      if (player !== undefined) return `${player.displayName} (${team.teamName})`;
    }
    return userId;
  };

  if (closed !== null) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="positive" title={closed.replayed ? 'Already settled' : 'Settled'}>
          The tournament is {closed.status.replace(/_/g, ' ')} and the contest is {closed.settlement.contestState}. Payout hash <code className="tabular">{closed.settlement.payoutHash.slice(0, 16)}…</code>.
        </Notice>
        <table className="w-full text-body">
          <thead>
            <tr className="text-left">
              <th className="label py-1 text-text-secondary">Place</th>
              <th className="label py-1 text-text-secondary">Player</th>
              <th className="label py-1 text-right text-text-secondary">Payout</th>
            </tr>
          </thead>
          <tbody>
            {closed.settlement.results.map((r) => (
              <tr key={r.userId} className="text-text-primary">
                <td className="tabular py-1">{r.placement}</td>
                <td className="py-1">{nameOf(r.userId)}</td>
                <td className="tabular py-1 text-right">{r.payoutAmount} POINTS</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Step 1 · Frozen preview</Label>
        <p className="text-body text-text-secondary">Purse computes the settlement from the final standings and returns a hash of the payout set. Nothing moves.</p>
        <div>
          <Button onClick={() => void fetchPreview()} disabled={busy !== null}>
            {busy === 'preview' ? 'Fetching…' : preview === null ? 'Fetch the preview' : 'Fetch a fresh preview'}
          </Button>
        </div>
      </div>
      {error === null ? null : (
        <Notice tone="error" title="Refused">
          {error.message}
          {error.detail === undefined ? null : <Pre value={error.detail} />}
        </Notice>
      )}
      {preview === null ? null : (
        <div className="flex flex-col gap-3 rounded-input border border-border-subtle bg-bg-inset p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="live">contest {preview.contestState.replace(/_/g, ' ')}</Chip>
            <Chip>escrow {preview.escrowTotal} POINTS</Chip>
            <Chip>previewed {new Date(preview.previewedAt).toLocaleTimeString()}</Chip>
          </div>
          <table className="w-full text-body">
            <thead>
              <tr className="text-left">
                <th className="label py-1 text-text-secondary">Place</th>
                <th className="label py-1 text-text-secondary">Team</th>
                <th className="label py-1 text-right text-text-secondary">Payout per player</th>
              </tr>
            </thead>
            <tbody>
              {preview.standings.map((team) => (
                <tr key={team.teamId} className="text-text-primary">
                  <td className="tabular py-1">{team.placement}</td>
                  <td className="py-1">
                    {team.teamName}
                    <span className="block text-[0.8125rem] text-text-tertiary">{team.players.map((p) => p.displayName).join(' & ')}</span>
                  </td>
                  <td className="tabular py-1 text-right">
                    {team.players.map((p) => preview.payouts.find((x) => x.userId === p.purseUserId)?.payout ?? '—').join(' / ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-body text-text-secondary">
            Payouts sum to <span className="tabular text-text-primary">{preview.payouts.reduce((sum, p) => sum + BigInt(p.payout), 0n).toString()}</span> of {preview.escrowTotal} POINTS in escrow.
          </p>
          <div>
            <Label>Payout hash</Label>
            <code className="tabular mt-1 block break-all text-[0.8125rem] text-text-primary">{preview.payoutHash}</code>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label>Step 2 · Confirm</Label>
        <p className="text-body text-text-secondary">The close presents this hash. Purse recomputes the settlement and refuses if anything changed since the preview.</p>
        <div>
          <Button primary onClick={() => void confirm()} disabled={busy !== null || preview === null}>
            {busy === 'close' ? 'Closing…' : preview === null ? 'Fetch the preview first' : `Close with hash ${preview.payoutHash.slice(0, 12)}…`}
          </Button>
        </div>
      </div>
    </div>
  );
}
