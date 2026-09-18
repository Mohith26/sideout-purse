'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, useToast } from '@sideout/ui';

import { api } from '../../lib/api-client';
import { Notice } from '../ui/Notice';
import { StripePayment } from './StripePayment';

/**
 * Step 1's action: `POST /api/tournaments/:slug/register`, which reserves the place and
 * starts the entry donation with the configured provider. With Stripe the response carries
 * the PaymentIntent's client secret and the Payment Element mounts here; with the dev
 * provider the donation is pending and settles after a short delay, which the page shows
 * as it happens. The page re-renders from rows afterwards, so the pending → received
 * change is whatever the provider says, never assumed here.
 */
export type RegisterResponse = { team: { id: string; name: string; status: string }; donation: { id: string; status: string } | null; clientSecret: string | null; reservationExpiresAt: string | null };

export function RegisterButton({ slug, teamId, label, stripePublishableKey, tournamentName }: { slug: string; teamId: string; label: string; stripePublishableKey: string | null; tournamentName: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ clientSecret: string; donationId: string } | null>(null);

  if (payment !== null) {
    return <StripePayment publishableKey={stripePublishableKey} clientSecret={payment.clientSecret} donationId={payment.donationId} tournamentName={tournamentName} />;
  }

  return (
    <div className="space-y-3">
      {error === null ? null : (
        <Notice tone="error" title="Registration did not go through">
          {error}
        </Notice>
      )}
      <ActionButton
        variant="primary"
        large
        wrap
        block
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await api<RegisterResponse>(`/api/tournaments/${slug}/register`, { method: 'POST', body: { teamId } });
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          if (result.data.clientSecret !== null && result.data.donation !== null) {
            setPayment({ clientSecret: result.data.clientSecret, donationId: result.data.donation.id });
            router.refresh();
            return;
          }
          toast({ tone: 'success', title: 'Your place is reserved', body: result.data.donation === null ? 'No entry donation for this event.' : 'Your donation is being processed.' });
          router.refresh();
        }}
      >
        {busy ? 'Registering…' : label}
      </ActionButton>
    </div>
  );
}
