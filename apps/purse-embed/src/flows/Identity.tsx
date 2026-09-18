'use client';

import { useState } from 'react';
import type { ApiError, EmbedUserState, VerificationResource } from '@purse/types';

import { toApiError, type EmbedApi } from '../embed/api';
import { Button, ErrorNotice, Notice } from '../components/ui';

/**
 * The identity flow (spec 4.8): starts the check through the `IdentityProvider` seam and
 * shows its outcome. With the dev provider the answer is immediate; a real vendor would
 * open its inquiry here and the state would stay `pending` until its webhook. `rejected`
 * is terminal for the user (spec 5.3): an explanation and a support path, no retry.
 */
export function Identity({ api, state, onDone, onState, onError }: { api: EmbedApi; state: EmbedUserState; onDone: (verification: VerificationResource) => void; onState: (state: EmbedUserState) => void; onError: (error: ApiError) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  if (!state.authenticated) return <Notice tone="error" title="No session">Open this flow with an embed token or sign in first.</Notice>;
  const verification = state.user.verification;

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const started = await api.startIdentity();
      onState(started.state);
      if (started.verification.state !== 'pending') onDone(started.verification);
    } catch (caught) {
      const failure = toApiError(caught);
      setError(failure);
      onError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row">
        <span className="row__label">Identity</span>
        <span className={`chip${verification.state === 'verified' ? ' chip--live' : verification.state === 'rejected' ? ' chip--fault' : ''}`}>{verification.state}</span>
      </div>
      {verification.state === 'unstarted' ? (
        <p className="embed__lede">Verify who you are to enter contests that need it. We check your name and date of birth with a verification partner; no document is stored by Purse.</p>
      ) : null}
      {verification.state === 'pending' ? <Notice tone="info" title="Under review">Your check is in progress. You can close this and come back; we will let you know.</Notice> : null}
      {verification.state === 'verified' ? (
        <Notice tone="positive" title="Verified">
          {verification.verifiedAt === null ? '' : `Confirmed on ${new Date(verification.verifiedAt).toLocaleDateString()}.`}
          {verification.reverifyAfter === null ? '' : ` Valid until ${new Date(verification.reverifyAfter).toLocaleDateString()}.`}
        </Notice>
      ) : null}
      {verification.state === 'rejected' ? (
        <Notice tone="error" title="We could not verify your identity">
          This decision is final for this account. If you think it is wrong, contact support and quote your account id {state.user.id}.
        </Notice>
      ) : null}
      {error === undefined ? null : <ErrorNotice error={error} />}
      <div className="actions">
        {verification.state === 'unstarted' || verification.state === 'pending' ? (
          <Button onClick={() => void start()} disabled={busy}>
            {verification.state === 'pending' ? 'Check again' : 'Verify my identity'}
          </Button>
        ) : null}
        {verification.state === 'verified' ? <Button onClick={() => onDone(verification)}>Done</Button> : null}
      </div>
    </div>
  );
}
