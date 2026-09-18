import { and, eq } from 'drizzle-orm';

import { donations, teamMembers } from '../../../../../../db/schema';
import { requireUser } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import { DonationProviderError } from '../../../../../../server/donations/provider';
import { failure } from '../../../../../../server/http/errors';
import type { RouteContext } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * What the browser needs to resume a pending entry donation it started (a reload in the
 * middle of a Stripe checkout): the provider's client secret, retrieved fresh from the
 * provider, never stored. Only a member of the team the donation is for may ask, and only
 * while the donation is pending; the dev provider answers with no secret, since it needs
 * nothing from the browser.
 */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const { db, env, donationProvider } = appContext();
    const now = new Date();
    const user = await requireUser(request, { db, sessionSecret: env.sessionSecret, now });
    const { id } = await context.params;
    const [donation] = await db.select().from(donations).where(eq(donations.id, id));
    if (donation === undefined) throw failure.notFound('donation_not_found', 'No such donation.');
    const [member] = donation.teamId === null ? [] : await db.select({ id: teamMembers.id }).from(teamMembers).where(and(eq(teamMembers.teamId, donation.teamId), eq(teamMembers.userId, user.id)));
    if (member === undefined && donation.userId !== user.id) throw failure.permission('not_your_donation', 'Only a member of the team can resume its donation.');
    if (donation.status !== 'pending') return ok({ id: donation.id, status: donation.status, clientSecret: null });
    if (donationProvider?.name !== donation.provider) throw failure.internal('donation_provider_unavailable', 'The donation provider is not configured.').withStatus(503);
    try {
      const payment = await donationProvider.retrievePayment(donation.providerRef, { requestId });
      return ok({ id: donation.id, status: donation.status, clientSecret: payment.clientSecret });
    } catch (error) {
      if (error instanceof DonationProviderError) throw failure.internal('donation_provider_error', 'The donation provider did not answer.').withStatus(503);
      throw error;
    }
  });
}
