import { WEBHOOK_SIGNATURE_HEADER } from '@purse/types';

import { appContext } from '../../../../server/context';
import { fail, handle, ok } from '../../../../server/http/respond';
import { receivePurseWebhook } from '../../../../server/purse/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Purse's webhooks (spec 4.9). The raw body is read first and verified as received;
 * nothing is parsed before the signature passes. Every event is acknowledged once it is
 * recorded, including duplicates and types Sideout does not handle.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const app = appContext();
    const rawBody = await request.text();
    const outcome = await receivePurseWebhook(
      { db: app.db, log: app.log, secret: app.env.purse.webhookSecret },
      { rawBody, signatureHeader: request.headers.get(WEBHOOK_SIGNATURE_HEADER), now: new Date(), reservationTtlMs: app.env.reservationTtlMs },
    );
    if (outcome.outcome === 'rejected') {
      const type = outcome.status === 401 ? 'authentication_error' : outcome.status === 400 ? 'invalid_request' : 'internal_error';
      return fail({ type, code: outcome.reason, message: `Webhook rejected: ${outcome.reason}` }, outcome.status);
    }
    return ok({ received: true, outcome: outcome.outcome, eventId: outcome.eventId, eventType: outcome.eventType, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) });
  });
}
