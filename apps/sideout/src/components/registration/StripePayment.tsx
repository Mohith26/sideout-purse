'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Appearance, type Stripe } from '@stripe/stripe-js';
import { ActionButton, useToast } from '@sideout/ui';

import { api } from '../../lib/api-client';
import { Notice } from '../ui/Notice';

/**
 * Stripe's Payment Element for the entry donation (spec 5.3, "Register": the donation is
 * Stripe's, real dollars, never a stake), mounted with the PaymentIntent's client secret
 * the register route returned and themed on the ember accent so it reads as the charity
 * step. Confirmation stays on this page (`redirect: 'if_required'`); the webhook then
 * moves the donation to received and the page shows that when it lands.
 */
const APPEARANCE: Appearance = {
  theme: 'night',
  variables: { colorPrimary: '#ff6b3d', colorBackground: '#050607', colorText: '#f4f5f7', colorTextSecondary: '#9ba3af', colorDanger: '#ff4d4d', borderRadius: '6px', fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif', fontSizeBase: '15px' },
  rules: { '.Input': { border: '1px solid #323843' }, '.Input:focus': { border: '1px solid #ff6b3d', boxShadow: 'none' } },
};

let stripePromise: Promise<Stripe | null> | null = null;

function stripeFor(publishableKey: string): Promise<Stripe | null> {
  stripePromise ??= loadStripe(publishableKey);
  return stripePromise;
}

export function StripePayment({ publishableKey, clientSecret, donationId, tournamentName }: { publishableKey: string | null; clientSecret: string; donationId: string; tournamentName: string }) {
  const stripe = useMemo(() => (publishableKey === null ? null : stripeFor(publishableKey)), [publishableKey]);
  if (publishableKey === null || stripe === null) {
    return (
      <Notice tone="attention" title="The card form is not available on this server" testId="stripe-unavailable">
        Your place is reserved and the donation is pending, but this deployment has no <code className="so-mono">NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>, so the payment form cannot open. Ask the organizer.
      </Notice>
    );
  }
  return (
    <Elements stripe={stripe} options={{ clientSecret, appearance: APPEARANCE }}>
      <PaymentForm donationId={donationId} tournamentName={tournamentName} />
    </Elements>
  );
}

function PaymentForm({ donationId, tournamentName }: { donationId: string; tournamentName: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = stripe !== null && elements !== null;

  const confirm = async () => {
    if (stripe === null || elements === null) return;
    setBusy(true);
    setError(null);
    const result = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } });
    setBusy(false);
    if (result.error !== undefined) {
      setError(result.error.message ?? 'The payment was not accepted.');
      return;
    }
    toast({ tone: 'success', title: 'Thank you', body: `Your donation to ${tournamentName}’s beneficiary is on its way. The confirmation lands in a moment.` });
    // Read the donation back so the page reflects the provider's word, not the browser's.
    await api(`/api/me/donations/${donationId}/payment`);
    router.refresh();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
      className="space-y-3"
      data-testid="stripe-payment"
    >
      <PaymentElement options={{ layout: 'tabs' }} />
      {error === null ? null : (
        <Notice tone="error" title="The payment was not accepted">
          {error}
        </Notice>
      )}
      <ActionButton type="submit" variant="primary" large block disabled={!ready || busy} aria-busy={busy}>
        {busy ? 'Confirming…' : 'Confirm donation'}
      </ActionButton>
      <p className="type-label text-text-tertiary">Processed by Stripe. Sideout never sees your card.</p>
    </form>
  );
}
