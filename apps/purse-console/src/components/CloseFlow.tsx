'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, DataTable, Money, Mono, Notice } from '@sideout/ui';
import type { ApiError, ConsoleSettlementResource, PreviewResource } from '@purse/types';

import { api, newIdempotencyKey } from '../lib/client';
import { ErrorNotice } from './ErrorNotice';

/**
 * The close flow, the two-step commit of spec 4.7 and 4.10. Step one fetches the frozen
 * preview: the placements, the payouts and the payout hash, computed by the same pure
 * function the close runs. The hash is held on screen exactly as received; nothing here
 * recomputes or edits it. Step two is an explicit confirm that posts that hash and
 * nothing else; the API recomputes and refuses (`conflict`, `preview_hash_mismatch`) if
 * a score changed in between, in which case the operator fetches a fresh preview. One
 * idempotency key covers the confirm and any retry of it, so a double click or a lost
 * response can never settle twice.
 */
export type CloseFlowProps = {
  tenantId: string;
  contestId: string;
  asset: string;
  /** Display names by user id, for the placements table. */
  names?: Record<string, string>;
  /** Called after a settlement; the page refreshes its server data by default. */
  onSettled?: (settlement: ConsoleSettlementResource) => void;
};

type Step = 'preview' | 'confirm' | 'settled';

export function CloseFlow({ tenantId, contestId, asset, names = {}, onSettled }: CloseFlowProps) {
  const router = useRouter();
  const base = `/tenants/${tenantId}/contests/${contestId}`;
  const [preview, setPreview] = useState<PreviewResource | null>(null);
  const [step, setStep] = useState<Step>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [settlement, setSettlement] = useState<ConsoleSettlementResource | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string>(newIdempotencyKey());

  const fetchPreview = useCallback(async () => {
    // Every state change happens after the first await, so an effect may call this directly.
    const res = await api.get<PreviewResource>(`${base}/preview`);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      setPreview(null);
      return;
    }
    setPreview(res.data);
    setStep('preview');
    // A fresh preview is a fresh action: a confirm of it gets its own key.
    idempotencyKey.current = newIdempotencyKey();
  }, [base]);

  useEffect(() => {
    // Scheduled, not synchronous, so the effect itself sets no state.
    queueMicrotask(() => {
      void fetchPreview();
    });
  }, [fetchPreview]);

  async function refresh() {
    setLoading(true);
    setError(null);
    await fetchPreview();
  }

  async function confirm() {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    const res = await api.post<ConsoleSettlementResource>(`${base}/close`, { payoutHash: preview.payoutHash }, { idempotencyKey: idempotencyKey.current });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSettlement(res.data);
    setStep('settled');
    if (onSettled === undefined) router.refresh();
    else onSettled(res.data);
  }

  const total = preview === null ? 0n : preview.payouts.reduce((sum, payout) => sum + BigInt(payout.payout), 0n);

  return (
    <Card title="Close contest" actions={step === 'settled' ? undefined : <Button small onClick={refresh} disabled={loading || busy}>Refresh preview</Button>}>
      <div className="steps" aria-label="Close flow steps">
        <div className={`step ${step === 'preview' ? 'step--active' : 'step--done'}`}>
          <span className="step__label">Step 1</span>
          <span className="step__title">Frozen preview</span>
          <span>Placements, payouts and the payout hash, computed by the settlement engine. Nothing has moved.</span>
        </div>
        <div className={`step ${step === 'confirm' ? 'step--active' : step === 'settled' ? 'step--done' : ''}`}>
          <span className="step__label">Step 2</span>
          <span className="step__title">Confirm with the hash</span>
          <span>The close presents exactly this hash. If anything changed, the API refuses and you preview again.</span>
        </div>
      </div>
      {loading ? <p className="console__lede">Computing the preview…</p> : null}
      {error === null ? null : <ErrorNotice error={error} title={error.code === 'preview_hash_mismatch' ? 'The preview is stale' : undefined} />}
      {error?.code === 'preview_hash_mismatch' ? (
        <div>
          <Button onClick={refresh}>Fetch a fresh preview</Button>
        </div>
      ) : null}
      {preview === null ? null : (
        <>
          <dl className="so-kv">
            <div style={{ display: 'contents' }}>
              <dt>Escrow total</dt>
              <dd>
                <Money amount={preview.escrowTotal} asset={asset} />
              </dd>
            </div>
            <div style={{ display: 'contents' }}>
              <dt>Payouts total</dt>
              <dd>
                <Money amount={total} asset={asset} /> {total === BigInt(preview.escrowTotal) ? <span className="balanced balanced--ok">equals escrow</span> : <span className="balanced balanced--broken">does not equal escrow</span>}
              </dd>
            </div>
            <div style={{ display: 'contents' }}>
              <dt>Payout hash</dt>
              <dd>
                <Mono>
                  <span data-testid="payout-hash">{preview.payoutHash}</span>
                </Mono>
              </dd>
            </div>
          </dl>
          <DataTable
            caption="Frozen placements and payouts"
            rows={preview.payouts}
            rowKey={(row) => row.userId}
            empty="No entrants to pay."
            columns={[
              { key: 'placement', header: 'Place', numeric: true, render: (row) => row.placement },
              { key: 'user', header: 'User', render: (row) => names[row.userId] ?? row.userId },
              { key: 'score', header: 'Score', numeric: true, render: (row) => preview.entries.find((entry) => entry.userId === row.userId)?.score ?? '—' },
              { key: 'payout', header: 'Payout', numeric: true, render: (row) => <Money amount={row.payout} asset={asset} /> },
            ]}
          />
        </>
      )}
      {step === 'preview' && preview !== null ? (
        <div className="so-actions">
          <Button variant="primary" onClick={() => setStep('confirm')} disabled={busy || loading}>
            Continue to confirm
          </Button>
        </div>
      ) : null}
      {step === 'confirm' && preview !== null ? (
        <div className="stack">
          <Notice tone="warning" title="This settles the contest">
            One `settle` entry credits every winner from escrow and the contest becomes `settled`. This cannot be undone; a correction is a reversal.
          </Notice>
          <div className="so-actions">
            <Button variant="primary" onClick={confirm} disabled={busy}>
              {busy ? 'Settling…' : 'Confirm close with this hash'}
            </Button>
            <Button onClick={() => setStep('preview')} disabled={busy}>
              Back
            </Button>
          </div>
        </div>
      ) : null}
      {step === 'settled' && settlement !== null ? (
        <Notice tone="positive" title={settlement.replayed ? 'Already settled under this key' : 'Settled'}>
          {settlement.results.length} results recorded; escrow now {settlement.contest.escrowBalance} {asset}. Settlement entry <Mono>{settlement.journalEntryId ?? '—'}</Mono>.
        </Notice>
      ) : null}
    </Card>
  );
}
