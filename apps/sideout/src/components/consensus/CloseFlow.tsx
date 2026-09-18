'use client';

import { useState } from 'react';
import { ActionButton, ConfirmDialog, Icons, useToast } from '@sideout/ui';

import { api } from '../../lib/api-client';
import { formatPoints, formatTime } from '../../lib/format';
import { Notice } from '../ui/Notice';
import { FrozenPreview, type FrozenStandingRow } from './FrozenPreview';

/**
 * The two-step close (spec 5.3 item 6, 4.7): fetch Purse's frozen preview and show it with
 * its payout hash, then confirm the close with that exact hash behind a confirm dialog. A
 * stale preview is refused by Purse, which the second step reports; the organizer then
 * fetches a fresh one.
 */
export type ClosePreviewData = {
  payoutHash: string;
  escrowTotal: string;
  contestState: string;
  previewedAt: string;
  standings: FrozenStandingRow[];
  payouts: Array<{ userId: string; placement: number; payout: string }>;
};

export type ClosedData = { status: string; replayed: boolean; settlement: { contestState: string; payoutHash: string; results: Array<{ userId: string; placement: number; payoutAmount: string }> } };

export function CloseFlow({ tournamentId, initial, timeZone }: { tournamentId: string; initial: ClosePreviewData | null; timeZone: string }) {
  const { toast } = useToast();
  const [preview, setPreview] = useState<ClosePreviewData | null>(initial);
  const [closed, setClosed] = useState<ClosedData | null>(null);
  const [busy, setBusy] = useState<'preview' | 'close' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPreview = async () => {
    setBusy('preview');
    setError(null);
    const result = await api<ClosePreviewData>(`/api/admin/tournaments/${tournamentId}/close/preview`);
    setBusy(null);
    if (!result.ok) {
      setPreview(null);
      setError(result.error.message);
      return;
    }
    setPreview(result.data);
  };

  const confirm = async () => {
    if (preview === null) return;
    setBusy('close');
    setError(null);
    const result = await api<ClosedData>(`/api/admin/tournaments/${tournamentId}/close`, { method: 'POST', body: { payoutHash: preview.payoutHash } });
    setBusy(null);
    setConfirming(false);
    if (!result.ok) {
      if (result.error.code === 'preview_hash_mismatch') setPreview(null);
      setError(result.error.message);
      return;
    }
    setClosed(result.data);
    toast({ tone: 'success', title: result.data.replayed ? 'Already settled' : 'Settled through Purse', body: 'Payouts have landed in the winners’ wallets.' });
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
      <div className="space-y-4" data-testid="close-settled">
        <Notice tone="success" title={closed.replayed ? 'Already settled' : 'Settled'}>
          The tournament is {closed.status.replace(/_/g, ' ')} and the contest is {closed.settlement.contestState}. Payout hash <code className="so-mono">{closed.settlement.payoutHash.slice(0, 16)}…</code>
        </Notice>
        <div className="surface-raised relative overflow-x-auto rounded-card" tabIndex={0} role="group" aria-label="Settlement results">
          <table className="w-full border-collapse text-body">
            <caption className="sr-only">Settlement results</caption>
            <thead>
              <tr className="border-b border-border-subtle">
                <th scope="col" className="px-4 py-2.5 text-start type-label text-text-tertiary">
                  Place
                </th>
                <th scope="col" className="px-3 py-2.5 text-start type-label text-text-tertiary">
                  Player
                </th>
                <th scope="col" className="px-4 py-2.5 text-end type-label text-text-tertiary">
                  Payout
                </th>
              </tr>
            </thead>
            <tbody>
              {closed.settlement.results.map((r) => (
                <tr key={r.userId} className="border-b border-border-subtle last:border-b-0 text-text-primary">
                  <td className="tabular px-4 py-2.5">{r.placement}</td>
                  <td className="px-3 py-2.5">{nameOf(r.userId)}</td>
                  <td className="tabular px-4 py-2.5 text-end">{formatPoints(r.payoutAmount, 'POINTS')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="close-step-1" className="space-y-3">
        <h3 id="close-step-1" className="type-label text-text-tertiary">
          Step 1 · Frozen preview
        </h3>
        <p className="text-text-secondary">Purse computes the settlement from the final standings and returns a hash of the payout set. Nothing moves.</p>
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton variant="secondary" onClick={() => void fetchPreview()} disabled={busy !== null} aria-busy={busy === 'preview'} iconStart={<Icons.shieldCheck size={16} />}>
            {busy === 'preview' ? 'Fetching…' : preview === null ? 'Fetch the preview' : 'Fetch a fresh preview'}
          </ActionButton>
          {preview === null ? null : (
            <span className="tabular type-label text-text-tertiary">
              previewed {formatTime(preview.previewedAt, timeZone)} · escrow {formatPoints(preview.escrowTotal, 'POINTS')}
            </span>
          )}
        </div>
      </section>
      {error === null ? null : (
        <Notice tone="error" title="Refused">
          {error}
        </Notice>
      )}
      {preview === null ? null : <FrozenPreview standings={preview.standings} payouts={preview.payouts} escrowTotal={preview.escrowTotal} payoutHash={preview.payoutHash} contestState={preview.contestState} />}
      <section aria-labelledby="close-step-2" className="space-y-3">
        <h3 id="close-step-2" className="type-label text-text-tertiary">
          Step 2 · Confirm
        </h3>
        <p className="text-text-secondary">The close presents this hash. Purse recomputes the settlement and refuses if anything changed since the preview.</p>
        <ActionButton variant="primary" large onClick={() => setConfirming(true)} disabled={busy !== null || preview === null} iconStart={<Icons.flag size={18} />}>
          {preview === null ? 'Fetch the preview first' : `Close with hash ${preview.payoutHash.slice(0, 12)}…`}
        </ActionButton>
      </section>
      <ConfirmDialog
        open={confirming}
        title="Close the tournament and settle?"
        body={preview === null ? undefined : `Purse pays out ${formatPoints(preview.escrowTotal, 'POINTS')} from escrow against hash ${preview.payoutHash.slice(0, 12)}…. This cannot be undone.`}
        confirmLabel="Close and settle"
        busy={busy === 'close'}
        onConfirm={() => void confirm()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
