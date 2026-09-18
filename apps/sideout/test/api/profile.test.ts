import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { GET as paymentResume } from '../../src/app/api/me/donations/[id]/payment/route';
import { GET as me, PATCH as renameMe } from '../../src/app/api/me/route';
import { POST as joinTeam } from '../../src/app/api/teams/[id]/join/route';
import { POST as createTeam } from '../../src/app/api/teams/route';
import { POST as register } from '../../src/app/api/tournaments/[slug]/register/route';
import { auditLog, donations, type Charity, type User } from '../../src/db/schema';
import { resetAppContext } from '../../src/server/context';
import { DonationProviderError, type DonationProvider } from '../../src/server/donations/provider';
import { cookieFor, createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { tournamentBody } from './fixtures';

/**
 * The two routes the profile and the register screen added in phase 8: renaming the
 * signed-in user (the first sign-in leaves a placeholder name), and resuming a pending
 * Stripe payment after a reload by fetching the client secret fresh from the provider.
 */
type TeamResponse = { team: { id: string } };
type RegisterResponse = { donation: { id: string; status: string } | null; clientSecret: string | null };

describe('PATCH /api/me', () => {
  let database: Database;
  let player: User;

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    player = await createUser(database, { displayName: 'Player 1234' });
  });
  afterAll(async () => {
    await database.close();
  });

  it('renames the signed-in user, audits it, and refuses a name that is too short or a visitor', async () => {
    const renamed = await data<{ user: { displayName: string; displayNameIsDefault: boolean } }>(await renameMe(request('PATCH', '/api/me', { body: { displayName: '  Maya Delgado ' }, cookie: cookieFor(player) })));
    expect(renamed.user).toMatchObject({ displayName: 'Maya Delgado', displayNameIsDefault: false });
    const snapshot = await data<{ user: { displayName: string } }>(await me(request('GET', '/api/me', { cookie: cookieFor(player) })));
    expect(snapshot.user.displayName).toBe('Maya Delgado');
    const [audit] = await database.db.select().from(auditLog).where(eq(auditLog.action, 'user.renamed'));
    expect(audit?.detail).toEqual({ from: 'Player 1234', to: 'Maya Delgado' });

    expect((await errorOf(await renameMe(request('PATCH', '/api/me', { body: { displayName: 'M' }, cookie: cookieFor(player) })))).code).toBe('validation_failed');
    expect((await errorOf(await renameMe(request('PATCH', '/api/me', { body: { displayName: 'Maya' } })))).code).toBe('sign_in_required');
  });
});

describe('GET /api/me/donations/:id/payment', () => {
  let database: Database;
  let organizer: User;
  let captain: User;
  let partner: User;
  let stranger: User;
  let charity: Charity;
  let slug: string;
  const retrieved: string[] = [];

  const stripeLike: DonationProvider = {
    name: 'stripe',
    createPayment: async (req) => {
      await Promise.resolve();
      return { providerRef: `pi_${req.donationId}`, clientSecret: `pi_${req.donationId}_secret`, status: 'pending' };
    },
    cancelPayment: () => Promise.resolve(),
    retrievePayment: async (providerRef) => {
      await Promise.resolve();
      retrieved.push(providerRef);
      if (providerRef === 'pi_refuses') throw new DonationProviderError('stripe', 'Stripe returned 500', 500);
      return { providerRef, clientSecret: `${providerRef}_secret_fresh`, status: 'pending' };
    },
  };

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    resetAppContext({ donationProvider: stripeLike });
    retrieved.length = 0;
    organizer = await createUser(database, { role: 'organizer' });
    captain = await createUser(database, { displayName: 'Maya Delgado' });
    partner = await createUser(database, { displayName: 'Tomas Okafor' });
    stranger = await createUser(database, { displayName: 'Someone Else' });
    charity = await createCharity(database);
    const created = await data<{ tournament: { id: string; slug: string } }>(await createTournament(request('POST', '/api/admin/tournaments', { body: tournamentBody(charity), cookie: cookieFor(organizer) })));
    slug = created.tournament.slug;
    await patchTournament(request('PATCH', '/x', { body: { status: 'registration_open' }, cookie: cookieFor(organizer) }), params({ id: created.tournament.id }));
  });
  afterAll(async () => {
    resetAppContext();
    await database.close();
  });

  async function pendingDonation(): Promise<{ donationId: string; clientSecret: string | null }> {
    const { team } = await data<TeamResponse>(await createTeam(request('POST', '/api/teams', { body: { tournamentSlug: slug, name: 'Delgado / Okafor', partnerPhone: partner.phoneE164 }, cookie: cookieFor(captain) })));
    await joinTeam(request('POST', `/api/teams/${team.id}/join`, { cookie: cookieFor(partner) }), params({ id: team.id }));
    const registered = await data<RegisterResponse>(await register(request('POST', `/api/tournaments/${slug}/register`, { body: { teamId: team.id }, cookie: cookieFor(captain) }), params({ slug })));
    if (registered.donation === null) throw new Error('expected a donation');
    return { donationId: registered.donation.id, clientSecret: registered.clientSecret };
  }

  it('hands a team member the client secret fetched fresh from the provider while the payment is pending', async () => {
    const { donationId, clientSecret } = await pendingDonation();
    expect(clientSecret).toMatch(/_secret$/);
    const resumed = await data<{ status: string; clientSecret: string | null }>(await paymentResume(request('GET', `/api/me/donations/${donationId}/payment`, { cookie: cookieFor(partner) }), params({ id: donationId })));
    expect(resumed).toEqual({ id: donationId, status: 'pending', clientSecret: `pi_${donationId}_secret_fresh` });
    expect(retrieved).toEqual([`pi_${donationId}`]);
  });

  it('refuses a stranger and a visitor, and answers no secret once the donation is no longer pending', async () => {
    const { donationId } = await pendingDonation();
    expect((await errorOf(await paymentResume(request('GET', '/x', { cookie: cookieFor(stranger) }), params({ id: donationId })))).code).toBe('not_your_donation');
    expect((await errorOf(await paymentResume(request('GET', '/x'), params({ id: donationId })))).code).toBe('sign_in_required');
    expect((await errorOf(await paymentResume(request('GET', '/x', { cookie: cookieFor(captain) }), params({ id: 'don_missing' })))).code).toBe('donation_not_found');
    await database.db.update(donations).set({ status: 'succeeded' }).where(eq(donations.id, donationId));
    const settled = await data<{ status: string; clientSecret: string | null }>(await paymentResume(request('GET', '/x', { cookie: cookieFor(captain) }), params({ id: donationId })));
    expect(settled).toEqual({ id: donationId, status: 'succeeded', clientSecret: null });
  });

  it('answers 503 when the provider cannot be reached, without leaking its message', async () => {
    const { donationId } = await pendingDonation();
    await database.db.update(donations).set({ providerRef: 'pi_refuses' }).where(eq(donations.id, donationId));
    const response = await paymentResume(request('GET', '/x', { cookie: cookieFor(captain) }), params({ id: donationId }));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).not.toContain('500');
  });
});
