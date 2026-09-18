import { appContext } from '../../../../server/context';
import { applyStripeEvent, cancelSupersededPayments } from '../../../../server/donations/service';
import { STRIPE_SIGNATURE_HEADER, stripeEventSchema, verifyStripeSignature } from '../../../../server/donations/stripe';
import { failure } from '../../../../server/http/errors';
import { handle, ok } from '../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Stripe's webhook receiver. The signature is verified over the raw body before anything
 * is parsed; events are applied idempotently on their id, so Stripe's retries are
 * acknowledged without touching the donation twice. Without a Stripe configuration the
 * endpoint does not accept anything.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async ({ requestId, log }) => {
    const { db, env, donationProvider } = appContext();
    if (env.stripe === undefined) throw failure.notFound('stripe_not_configured', 'Stripe is not configured.');

    const rawBody = await request.text();
    const verdict = verifyStripeSignature({ rawBody, header: request.headers.get(STRIPE_SIGNATURE_HEADER), secret: env.stripe.webhookSecret, now: new Date() });
    if (!verdict.ok) {
      log.warn('stripe webhook rejected', { reason: verdict.reason });
      throw failure.authentication(`signature_${verdict.reason}`, 'The webhook signature could not be verified.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw failure.invalidRequest('malformed_json', 'The event body is not valid JSON.');
    }
    const event = stripeEventSchema.safeParse(parsed);
    if (!event.success) throw failure.invalidRequest('malformed_event', 'The event does not look like a Stripe event.');

    const outcome = await applyStripeEvent(db, event.data, { now: new Date(), reservationTtlMs: env.reservationTtlMs });
    log.info('stripe webhook', { eventId: event.data.id, type: event.data.type, ...outcome });
    const cancelled =
      outcome.duplicate || !outcome.applied || outcome.registration !== 'confirmed' || donationProvider === null
        ? []
        : await cancelSupersededPayments({ db, provider: donationProvider, log }, { donationId: outcome.donationId, requestId });
    return ok({ received: true, eventId: event.data.id, ...outcome, cancelledDonationIds: cancelled });
  });
}
