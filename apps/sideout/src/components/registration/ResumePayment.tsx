'use client';

import { useEffect, useState } from 'react';

import { api } from '../../lib/api-client';
import { Notice } from '../ui/Notice';
import { StripePayment } from './StripePayment';

/**
 * A pending Stripe donation after a reload: the client secret is fetched fresh from the
 * provider (never stored) and the Payment Element mounts again so the captain can finish;
 * a payment that has since completed or been cancelled shows nothing here, since the page
 * re-renders from the donation row.
 */
export function ResumePayment({ donationId, stripePublishableKey, tournamentName }: { donationId: string; stripePublishableKey: string | null; tournamentName: string }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; clientSecret: string } | { kind: 'none' } | { kind: 'error'; message: string }>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void api<{ clientSecret: string | null }>(`/api/me/donations/${donationId}/payment`).then((result) => {
      if (cancelled) return;
      if (!result.ok) setState({ kind: 'error', message: result.error.message });
      else if (result.data.clientSecret === null) setState({ kind: 'none' });
      else setState({ kind: 'ready', clientSecret: result.data.clientSecret });
    });
    return () => {
      cancelled = true;
    };
  }, [donationId]);
  if (state.kind === 'loading') return <p className="text-text-secondary">Checking the payment with the provider…</p>;
  if (state.kind === 'error')
    return (
      <Notice tone="error" title="Could not reach the payment provider">
        {state.message}
      </Notice>
    );
  if (state.kind === 'none') return null;
  return <StripePayment publishableKey={stripePublishableKey} clientSecret={state.clientSecret} donationId={donationId} tournamentName={tournamentName} />;
}
