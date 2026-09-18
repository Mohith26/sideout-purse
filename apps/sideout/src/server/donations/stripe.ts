import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { DonationProviderError, type DonationProvider } from './provider';

/**
 * Stripe, test-mode keys from the environment, spoken to directly over its REST API: a
 * PaymentIntent per donation, created with the donation id as the idempotency key so a
 * retried registration cannot charge twice. `fetch` is injected so tests never reach the
 * network (`test/donations/stripe.test.ts` records the exchange as fixtures).
 */

export const STRIPE_API_BASE = 'https://api.stripe.com';

const paymentIntentSchema = z.object({
  id: z.string().min(1),
  client_secret: z.string().nullable(),
  status: z.string(),
});

export type StripeConfig = {
  secretKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
};

export function stripeDonationProvider(config: StripeConfig): DonationProvider {
  const doFetch = config.fetch ?? fetch;
  const baseUrl = config.baseUrl ?? STRIPE_API_BASE;

  return {
    name: 'stripe',
    async createPayment(request, options) {
      const form = new URLSearchParams();
      form.set('amount', request.amountCents.toString());
      form.set('currency', request.currency.toLowerCase());
      form.set('description', request.description);
      form.set('automatic_payment_methods[enabled]', 'true');
      for (const [key, value] of Object.entries(request.metadata)) form.set(`metadata[${key}]`, value);

      const response = await doFetch(`${baseUrl}/v1/payment_intents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': request.donationId,
          'x-request-id': options.requestId,
        },
        body: form.toString(),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new DonationProviderError('stripe', `Stripe returned ${response.status}: ${summarise(text)}`, response.status);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DonationProviderError('stripe', 'Stripe returned a non-JSON body');
      }
      const intent = paymentIntentSchema.safeParse(parsed);
      if (!intent.success) throw new DonationProviderError('stripe', 'Stripe returned an unexpected PaymentIntent shape');
      return {
        providerRef: intent.data.id,
        clientSecret: intent.data.client_secret,
        status: intent.data.status === 'succeeded' ? 'succeeded' : 'pending',
      };
    },
    async cancelPayment(providerRef, options) {
      const form = new URLSearchParams({ cancellation_reason: 'abandoned' });
      const response = await doFetch(`${baseUrl}/v1/payment_intents/${encodeURIComponent(providerRef)}/cancel`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': `cancel:${providerRef}`,
          'x-request-id': options.requestId,
        },
        body: form.toString(),
      });
      if (!response.ok) {
        throw new DonationProviderError('stripe', `Stripe returned ${response.status}: ${summarise(await response.text())}`, response.status);
      }
    },
  };
}

function summarise(body: string): string {
  const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(safeJson(body));
  return parsed.success ? parsed.data.error.message : body.slice(0, 200);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- Webhook signatures ------------------------------------------------------------------

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerdict = { ok: true; timestamp: number } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

/**
 * Verify `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` over the raw body: the signed
 * payload is `"{t}.{rawBody}"`, the MAC is HMAC-SHA256 with the endpoint secret, compared
 * in constant time, and a timestamp outside the tolerance window is rejected to prevent
 * replay. Same shape Purse's own webhooks use (spec 4.9).
 */
export function verifyStripeSignature(input: {
  rawBody: string;
  header: string | null;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): SignatureVerdict {
  if (input.header === null || input.header.length === 0) return { ok: false, reason: 'missing' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'malformed' };

  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) return { ok: false, reason: 'stale' };

  const expected = Buffer.from(signStripePayload(timestamp, input.rawBody, input.secret), 'hex');
  const matched = signatures.some((candidate) => {
    const given = Buffer.from(candidate, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched ? { ok: true, timestamp } : { ok: false, reason: 'mismatch' };
}

/** What Stripe (and the tests' fixture builder) computes for `v1`. */
export function signStripePayload(timestamp: number, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

// ---- Events ------------------------------------------------------------------------------

export const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({
    object: z.object({
      object: z.string(),
      id: z.string().optional(),
      payment_intent: z.string().nullable().optional(),
      /** On a charge: whether the whole amount has been refunded. */
      refunded: z.boolean().optional(),
      /** On a charge: the running total refunded so far, in minor units. */
      amount_refunded: z.number().int().min(0).optional(),
    }),
  }),
});

export type StripeEvent = z.infer<typeof stripeEventSchema>;

export type StripeEventEffect = {
  paymentIntentId: string;
  status: 'succeeded' | 'failed' | 'refunded';
  /** Set by `charge.refunded`: Stripe's cumulative `amount_refunded` for the charge. */
  refundedCents?: bigint;
};

/**
 * The PaymentIntent id an event is about, and the donation status it implies. Events
 * about anything else are recorded and ignored. A `payment_failed` is not terminal for
 * Stripe (the customer may retry on the same intent), which is why `failed → succeeded`
 * is an allowed donation transition in `service.ts`. Stripe sends `charge.refunded` for
 * partial refunds too: only `refunded: true` means the donation is refunded; otherwise the
 * donation stays `succeeded` and the running `amount_refunded` is recorded against it.
 */
export function interpretStripeEvent(event: StripeEvent): StripeEventEffect | null {
  const object = event.data.object;
  switch (event.type) {
    case 'payment_intent.succeeded':
      return object.id === undefined ? null : { paymentIntentId: object.id, status: 'succeeded' };
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      return object.id === undefined ? null : { paymentIntentId: object.id, status: 'failed' };
    case 'charge.refunded': {
      if (typeof object.payment_intent !== 'string' || object.refunded === undefined || object.amount_refunded === undefined) return null;
      return { paymentIntentId: object.payment_intent, status: object.refunded ? 'refunded' : 'succeeded', refundedCents: BigInt(object.amount_refunded) };
    }
    default:
      return null;
  }
}
