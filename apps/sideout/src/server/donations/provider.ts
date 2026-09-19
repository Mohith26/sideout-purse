/**
 * The donation provider seam (spec 1 "charity donations are the only real dollars",
 * 4.2.6, decision D3). A provider takes a payment for one donation row and reports a
 * reference Sideout stores as `donations.provider_ref`, and can cancel a payment that a
 * later one superseded so a captain is never left with two confirmable intents. Two
 * implementations:
 *
 * - `stripe` (`stripe.ts`): a PaymentIntent per registration, confirmed by the client
 *   with the returned `clientSecret`, and settled by the signed webhook receiver.
 * - `dev` (`dev.ts`): selected automatically outside production when no Stripe key is
 *   configured, and in production only under the public demo's `DEMO_ACCOUNTS` switch;
 *   marks the donation succeeded after a short clock-driven delay.
 *
 * In production with no Stripe key (and no demo switch) there is no provider, and
 * registration refuses with `donation_provider_unavailable` rather than faking success.
 */

export type PaymentRequest = {
  donationId: string;
  amountCents: bigint;
  /** ISO 4217, uppercase. */
  currency: string;
  description: string;
  metadata: Record<string, string>;
};

export type PaymentCreated = {
  providerRef: string;
  /** What the browser needs to complete the payment; null when nothing further is required. */
  clientSecret: string | null;
  status: 'pending' | 'succeeded';
};

export type DonationProvider = {
  readonly name: 'dev' | 'stripe';
  createPayment(request: PaymentRequest, options: { requestId: string }): Promise<PaymentCreated>;
  /** Cancel a payment that was never completed; a payment already taken is left alone (the caller refunds instead). */
  cancelPayment(providerRef: string, options: { requestId: string }): Promise<void>;
  /** What the browser needs to resume a payment it started (a reload mid-checkout); null when nothing is needed or the payment is over. */
  retrievePayment(providerRef: string, options: { requestId: string }): Promise<PaymentCreated>;
};

/** The provider answered with an error; the message is for the log, never the client. */
export class DonationProviderError extends Error {
  override readonly name = 'DonationProviderError';
  constructor(
    readonly provider: 'dev' | 'stripe',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
