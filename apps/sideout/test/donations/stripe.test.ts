import { eq } from 'drizzle-orm';
import { newId } from '@repo/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as getImpact } from '../../src/app/api/tournaments/[slug]/impact/route';
import { POST as webhook } from '../../src/app/api/webhooks/stripe/route';
import { auditLog, donationProviderEvents, donations, teams, tournaments, type Charity, type User } from '../../src/db/schema';
import { env, loadEnv } from '../../src/env';
import { mintPurseExternalId } from '../../src/server/actor';
import { resetAppContext } from '../../src/server/context';
import { DonationProviderError, type DonationProvider } from '../../src/server/donations/provider';
import { DONATION_TRANSITIONS } from '../../src/server/donations/service';
import { interpretStripeEvent, signStripePayload, stripeDonationProvider, verifyStripeSignature } from '../../src/server/donations/stripe';
import { createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';

const DEV_URL = 'postgres://sideout_app:secret@localhost:5432/sideout';
const WEBHOOK_SECRET = 'whsec_test_fixture_secret';

/** Recorded from Stripe's documented shapes; no test here reaches the network. */
const FIXTURES = {
  paymentIntentCreated: {
    id: 'pi_3QfixtureAbc123',
    object: 'payment_intent',
    amount: 5000,
    currency: 'usd',
    client_secret: 'pi_3QfixtureAbc123_secret_xyz',
    status: 'requires_payment_method',
    metadata: { donation_id: 'don_x' },
  },
  succeeded: (paymentIntentId: string, eventId = 'evt_fixture_succeeded_1') => ({
    id: eventId,
    object: 'event',
    type: 'payment_intent.succeeded',
    data: { object: { id: paymentIntentId, object: 'payment_intent', amount: 5000, status: 'succeeded' } },
  }),
  failed: (paymentIntentId: string, eventId = 'evt_fixture_failed_1') => ({
    id: eventId,
    object: 'event',
    type: 'payment_intent.payment_failed',
    data: { object: { id: paymentIntentId, object: 'payment_intent', status: 'requires_payment_method' } },
  }),
  refunded: (paymentIntentId: string, eventId = 'evt_fixture_refunded_1') => ({
    id: eventId,
    object: 'event',
    type: 'charge.refunded',
    data: { object: { id: 'ch_fixture', object: 'charge', payment_intent: paymentIntentId, amount: 5000, amount_refunded: 5000, refunded: true } },
  }),
  /** Stripe sends the same event type for a partial refund; the charge says how much and that it is not fully refunded. */
  partiallyRefunded: (paymentIntentId: string, amountRefunded: number, eventId = 'evt_fixture_partial_refund_1') => ({
    id: eventId,
    object: 'event',
    type: 'charge.refunded',
    data: { object: { id: 'ch_fixture', object: 'charge', payment_intent: paymentIntentId, amount: 5000, amount_refunded: amountRefunded, refunded: false } },
  }),
  unrelated: { id: 'evt_fixture_unrelated', object: 'event', type: 'customer.created', data: { object: { id: 'cus_1', object: 'customer' } } },
};

function signedHeader(rawBody: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${signStripePayload(t, rawBody, secret)}`;
}

describe('donation provider selection', () => {
  it('picks dev outside production without a key, stripe with one, and nothing in production without one', () => {
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL }).donationProvider).toBe('dev');
    expect(loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }).donationProvider).toBe('stripe');
    const production = { NODE_ENV: 'production', SIDEOUT_DATABASE_URL: DEV_URL, SESSION_SECRET: 'x'.repeat(32) };
    expect(loadEnv(production).donationProvider).toBe('none');
    expect(loadEnv({ ...production, STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }).donationProvider).toBe('stripe');
    expect(() => loadEnv({ SIDEOUT_DATABASE_URL: DEV_URL, STRIPE_SECRET_KEY: 'sk_test_1' })).toThrow(/set together/);
  });
});

describe('Stripe signature verification', () => {
  const rawBody = JSON.stringify(FIXTURES.succeeded('pi_1'));
  const now = new Date('2026-09-18T12:00:00Z');

  it('accepts a valid signature within tolerance, including one of several v1 entries', () => {
    const header = signedHeader(rawBody, WEBHOOK_SECRET, now);
    expect(verifyStripeSignature({ rawBody, header, secret: WEBHOOK_SECRET, now })).toEqual({ ok: true, timestamp: Math.floor(now.getTime() / 1000) });
    const rotated = `${header},v1=${'0'.repeat(64)}`;
    expect(verifyStripeSignature({ rawBody, header: rotated, secret: WEBHOOK_SECRET, now }).ok).toBe(true);
    const skewed = new Date(now.getTime() + 4 * 60_000);
    expect(verifyStripeSignature({ rawBody, header, secret: WEBHOOK_SECRET, now: skewed }).ok).toBe(true);
  });

  it('rejects missing, malformed, stale, wrong-secret and tampered-body signatures', () => {
    const header = signedHeader(rawBody, WEBHOOK_SECRET, now);
    expect(verifyStripeSignature({ rawBody, header: null, secret: WEBHOOK_SECRET, now })).toEqual({ ok: false, reason: 'missing' });
    expect(verifyStripeSignature({ rawBody, header: 'v1=abc', secret: WEBHOOK_SECRET, now })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyStripeSignature({ rawBody, header: 't=123', secret: WEBHOOK_SECRET, now })).toEqual({ ok: false, reason: 'malformed' });
    const late = new Date(now.getTime() + 6 * 60_000);
    expect(verifyStripeSignature({ rawBody, header, secret: WEBHOOK_SECRET, now: late })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyStripeSignature({ rawBody, header, secret: 'whsec_other', now })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyStripeSignature({ rawBody: `${rawBody} `, header, secret: WEBHOOK_SECRET, now })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('interprets the events that matter and ignores the rest', () => {
    expect(interpretStripeEvent(FIXTURES.succeeded('pi_1'))).toEqual({ paymentIntentId: 'pi_1', status: 'succeeded' });
    expect(interpretStripeEvent(FIXTURES.failed('pi_1'))).toEqual({ paymentIntentId: 'pi_1', status: 'failed' });
    expect(interpretStripeEvent(FIXTURES.refunded('pi_1'))).toEqual({ paymentIntentId: 'pi_1', status: 'refunded', refundedCents: 5000n });
    expect(interpretStripeEvent(FIXTURES.partiallyRefunded('pi_1', 500))).toEqual({ paymentIntentId: 'pi_1', status: 'succeeded', refundedCents: 500n });
    expect(interpretStripeEvent(FIXTURES.unrelated)).toBeNull();
  });

  it('documents the donation transitions the receiver will apply', () => {
    expect(DONATION_TRANSITIONS).toEqual({ pending: ['succeeded', 'failed', 'refunded'], failed: ['succeeded', 'refunded'], succeeded: ['refunded'], refunded: [] });
  });
});

describe('Stripe provider (no network)', () => {
  it('creates a PaymentIntent with the donation id as the idempotency key and returns its client secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} });
      await Promise.resolve();
      return new Response(JSON.stringify(FIXTURES.paymentIntentCreated), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = stripeDonationProvider({ secretKey: 'sk_test_fixture', fetch: fakeFetch });
    const created = await provider.createPayment(
      { donationId: 'don_x', amountCents: 5000n, currency: 'USD', description: 'Sideout entry donation: Sandbar Classic', metadata: { donation_id: 'don_x', team_id: 'tm_y' } },
      { requestId: 'req-1' },
    );
    expect(created).toEqual({ providerRef: 'pi_3QfixtureAbc123', clientSecret: 'pi_3QfixtureAbc123_secret_xyz', status: 'pending' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/payment_intents');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk_test_fixture');
    expect(headers['idempotency-key']).toBe('don_x');
    expect(headers['x-request-id']).toBe('req-1');
    const rawBody = calls[0]?.init.body;
    const body = new URLSearchParams(typeof rawBody === 'string' ? rawBody : '');
    expect(body.get('amount')).toBe('5000');
    expect(body.get('currency')).toBe('usd');
    expect(body.get('metadata[donation_id]')).toBe('don_x');
    expect(body.get('metadata[team_id]')).toBe('tm_y');
    expect(body.get('automatic_payment_methods[enabled]')).toBe('true');
  });

  it('turns a Stripe error into a DonationProviderError without exposing the secret', async () => {
    const failing: typeof fetch = async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ error: { message: 'Amount must be at least 50 cents' } }), { status: 400 });
    };
    const provider = stripeDonationProvider({ secretKey: 'sk_test_fixture', fetch: failing });
    const attempt = provider.createPayment({ donationId: 'don_x', amountCents: 10n, currency: 'USD', description: 'x', metadata: {} }, { requestId: 'r' });
    await expect(attempt).rejects.toBeInstanceOf(DonationProviderError);
    await expect(attempt).rejects.toThrow(/Stripe returned 400: Amount must be at least 50 cents/);
    await expect(attempt).rejects.not.toThrow(/sk_test_fixture/);
  });

  it('cancels a PaymentIntent idempotently, and reports a refusal without exposing the secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} });
      await Promise.resolve();
      if (calls.length === 1) return new Response(JSON.stringify({ ...FIXTURES.paymentIntentCreated, status: 'canceled' }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: 'This PaymentIntent has already succeeded' } }), { status: 400 });
    };
    const provider = stripeDonationProvider({ secretKey: 'sk_test_fixture', fetch: fakeFetch });
    await provider.cancelPayment('pi_3QfixtureAbc123', { requestId: 'req-2' });
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/payment_intents/pi_3QfixtureAbc123/cancel');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.init.method).toBe('POST');
    expect(headers['idempotency-key']).toBe('cancel:pi_3QfixtureAbc123');
    expect(headers['x-request-id']).toBe('req-2');
    expect(new URLSearchParams(typeof calls[0]?.init.body === 'string' ? calls[0].init.body : '').get('cancellation_reason')).toBe('abandoned');

    const refused = provider.cancelPayment('pi_3QfixtureAbc123', { requestId: 'req-3' });
    await expect(refused).rejects.toBeInstanceOf(DonationProviderError);
    await expect(refused).rejects.toThrow(/Stripe returned 400: This PaymentIntent has already succeeded/);
    await expect(refused).rejects.not.toThrow(/sk_test_fixture/);
  });
});

describe('POST /api/webhooks/stripe', () => {
  let database: Database;
  let charity: Charity;
  let captain: User;
  let tournamentId: string;
  let teamId: string;
  let donationId: string;
  const paymentIntentId = 'pi_3QfixtureAbc123';

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    charity = await createCharity(database);
    captain = await createUser(database);
    const [t] = await database.db
      .insert(tournaments)
      .values({
        id: newId('trn'),
        slug: 'hooked',
        name: 'Hooked',
        beneficiaryId: charity.id,
        venueName: 'v',
        venueCity: 'c',
        venueRegion: 'r',
        venueTimezone: 'UTC',
        startsAt: new Date(),
        endsAt: new Date(),
        format: 'single_elim',
        division: 'open',
        maxTeams: 8,
        entryDonationCents: 5000n,
        fundraisingGoalCents: 10000n,
        status: 'registration_open',
        purseExternalId: mintPurseExternalId('contest'),
      })
      .returning();
    tournamentId = t?.id ?? '';
    const [team] = await database.db.insert(teams).values({ id: newId('tm'), tournamentId, name: 'Hooked Pair', status: 'registered', registeredAt: new Date() }).returning();
    teamId = team?.id ?? '';
    const [donation] = await database.db
      .insert(donations)
      .values({ id: newId('don'), tournamentId, teamId, userId: captain.id, amountCents: 5000n, currency: 'USD', provider: 'stripe', providerRef: paymentIntentId, status: 'pending' })
      .returning();
    donationId = donation?.id ?? '';
    resetAppContext({ env: { ...env(), stripe: { secretKey: 'sk_test_fixture', webhookSecret: WEBHOOK_SECRET } } });
  });
  afterAll(async () => {
    await database.close();
  });

  const deliver = (event: unknown, options: { secret?: string; at?: Date; header?: string | null } = {}) => {
    const rawBody = JSON.stringify(event);
    const at = options.at ?? new Date();
    const header = options.header === undefined ? signedHeader(rawBody, options.secret ?? WEBHOOK_SECRET, at) : options.header;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (header !== null) headers['stripe-signature'] = header;
    return webhook(new Request('http://sideout.test/api/webhooks/stripe', { method: 'POST', headers, body: rawBody }));
  };

  it('applies a signed payment_intent.succeeded once, and acknowledges redeliveries without reapplying', async () => {
    const first = await deliver(FIXTURES.succeeded(paymentIntentId));
    expect(first.status).toBe(200);
    expect(await data(first)).toMatchObject({ received: true, duplicate: false, applied: true, donationId, from: 'pending', to: 'succeeded' });
    const [donation] = await database.db.select().from(donations).where(eq(donations.id, donationId));
    expect(donation?.status).toBe('succeeded');

    const again = await deliver(FIXTURES.succeeded(paymentIntentId));
    expect(await data(again)).toMatchObject({ received: true, duplicate: true });
    expect(await database.db.select().from(donationProviderEvents)).toHaveLength(1);
    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, donationId));
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'donation.succeeded', actorKind: 'system', actorUserId: null });
    expect(trail[0]?.detail).toMatchObject({ provider: 'stripe', eventId: 'evt_fixture_succeeded_1', from: 'pending' });

    // A different event id carrying the same news is recorded but changes nothing.
    const replayed = await deliver(FIXTURES.succeeded(paymentIntentId, 'evt_fixture_succeeded_2'));
    expect(await data(replayed)).toMatchObject({ duplicate: false, applied: false, reason: 'no_transition' });
  });

  it('a failed payment releases the team, a later success restores it, and a full refund withdraws it', async () => {
    expect(await data(await deliver(FIXTURES.failed(paymentIntentId)))).toMatchObject({ applied: true, registration: 'released' });
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]).toMatchObject({ status: 'forming', registeredAt: null });
    expect(await data(await deliver(FIXTURES.succeeded(paymentIntentId)))).toMatchObject({ applied: true, registration: 'confirmed' });
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]?.status).toBe('registered');
    expect(await data(await deliver(FIXTURES.refunded(paymentIntentId)))).toMatchObject({ applied: true, to: 'refunded', refundedCents: '5000', registration: 'withdrawn' });
    expect((await database.db.select().from(donations).where(eq(donations.id, donationId)))[0]).toMatchObject({ status: 'refunded', refundedCents: 5000n });
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]?.status).toBe('withdrawn');
    const teamTrail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, teamId)).orderBy(auditLog.createdAt, auditLog.id);
    expect(teamTrail.map((a) => (a.detail as { to: string; reason: string }))).toEqual([
      expect.objectContaining({ to: 'forming', reason: 'donation_failed' }),
      expect.objectContaining({ to: 'registered', reason: 'donation_succeeded' }),
      expect.objectContaining({ to: 'withdrawn', reason: 'donation_refunded' }),
    ]);
    const impact = await data<{ raisedCents: string; donationCount: number }>(await getImpact(request('GET', '/x'), params({ slug: 'hooked' })));
    expect(impact).toMatchObject({ raisedCents: '0', donationCount: 0 });
  });

  it('a partial refund keeps the team and the donation, records the amount, and lowers the impact figure', async () => {
    await deliver(FIXTURES.succeeded(paymentIntentId));
    const partial = await deliver(FIXTURES.partiallyRefunded(paymentIntentId, 500));
    expect(await data(partial)).toMatchObject({ applied: true, from: 'succeeded', to: 'succeeded', refundedCents: '500', registration: 'unchanged' });
    expect((await database.db.select().from(donations).where(eq(donations.id, donationId)))[0]).toMatchObject({ status: 'succeeded', refundedCents: 500n });
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]?.status).toBe('registered');
    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, donationId)).orderBy(auditLog.createdAt, auditLog.id);
    expect(trail.map((a) => a.action)).toEqual(['donation.succeeded', 'donation.refund_recorded']);
    expect(trail[1]?.detail).toMatchObject({ eventId: 'evt_fixture_partial_refund_1', from: 'succeeded', refundedCents: '500' });

    const impact = await data<{ raisedCents: string; donationCount: number; donors: Array<{ amountCents: string }> }>(
      await getImpact(request('GET', '/x'), params({ slug: 'hooked' })),
    );
    expect(impact).toMatchObject({ raisedCents: '4500', donationCount: 1 });
    expect(impact.donors[0]?.amountCents).toBe('4500');

    // A redelivered or older refund event never lowers the running total; a second partial raises it.
    expect(await data(await deliver(FIXTURES.partiallyRefunded(paymentIntentId, 300, 'evt_fixture_partial_refund_0')))).toMatchObject({ applied: false, reason: 'no_transition' });
    expect(await data(await deliver(FIXTURES.partiallyRefunded(paymentIntentId, 1200, 'evt_fixture_partial_refund_2')))).toMatchObject({ applied: true, refundedCents: '1200' });
    expect((await database.db.select().from(donations).where(eq(donations.id, donationId)))[0]?.refundedCents).toBe(1200n);
    // Refunding the rest is a full refund: the team withdraws.
    expect(await data(await deliver(FIXTURES.refunded(paymentIntentId)))).toMatchObject({ applied: true, to: 'refunded', registration: 'withdrawn' });
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]?.status).toBe('withdrawn');
  });

  it('rejects bad signatures, stale timestamps, missing headers and unknown intents; records unrelated events', async () => {
    const forged = await deliver(FIXTURES.succeeded(paymentIntentId), { secret: 'whsec_wrong' });
    expect(forged.status).toBe(401);
    expect(await errorOf(forged)).toMatchObject({ type: 'authentication_error', code: 'signature_mismatch' });
    const stale = await deliver(FIXTURES.succeeded(paymentIntentId), { at: new Date(Date.now() - 10 * 60_000) });
    expect((await errorOf(stale)).code).toBe('signature_stale');
    const missing = await deliver(FIXTURES.succeeded(paymentIntentId), { header: null });
    expect((await errorOf(missing)).code).toBe('signature_missing');
    expect((await database.db.select().from(donations).where(eq(donations.id, donationId)))[0]?.status).toBe('pending');
    expect(await database.db.select().from(donationProviderEvents)).toEqual([]);

    const unknown = await deliver(FIXTURES.succeeded('pi_nobody', 'evt_unknown'));
    expect(await data(unknown)).toMatchObject({ duplicate: false, applied: false, reason: 'unknown_payment_intent' });
    const unrelated = await deliver(FIXTURES.unrelated);
    expect(await data(unrelated)).toMatchObject({ duplicate: false, applied: false, reason: 'ignored_event_type' });
    expect(await database.db.select().from(donationProviderEvents)).toHaveLength(2);

    const malformed = await deliver({ id: 'evt_x', type: 'payment_intent.succeeded' });
    expect((await errorOf(malformed)).code).toBe('malformed_event');
  });

  it('applies a refund that arrives before the success, and records the late success without reviving the donation', async () => {
    expect(await data(await deliver(FIXTURES.refunded(paymentIntentId)))).toMatchObject({ applied: true, from: 'pending', to: 'refunded', refundedCents: '5000', registration: 'withdrawn' });
    expect((await database.db.select().from(donations).where(eq(donations.id, donationId)))[0]).toMatchObject({ status: 'refunded', refundedCents: 5000n });
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]?.status).toBe('withdrawn');

    expect(await data(await deliver(FIXTURES.succeeded(paymentIntentId)))).toMatchObject({ received: true, duplicate: false, applied: false, reason: 'already_refunded' });
    expect((await database.db.select().from(donations).where(eq(donations.id, donationId)))[0]?.status).toBe('refunded');
    expect((await database.db.select().from(teams).where(eq(teams.id, teamId)))[0]?.status).toBe('withdrawn');
    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, donationId)).orderBy(auditLog.createdAt, auditLog.id);
    expect(trail.map((a) => a.action)).toEqual(['donation.refunded', 'donation.succeeded_after_refund']);
    expect(trail[1]?.detail).toMatchObject({ eventId: 'evt_fixture_succeeded_1', refundedCents: '5000' });
    const impact = await data<{ raisedCents: string; donationCount: number }>(await getImpact(request('GET', '/x'), params({ slug: 'hooked' })));
    expect(impact).toMatchObject({ raisedCents: '0', donationCount: 0 });

    // A refund that lands on a failed payment (a retried card that was charged after all) is a refund too.
    await database.db.update(donations).set({ status: 'failed', refundedCents: 0n }).where(eq(donations.id, donationId));
    expect(await data(await deliver(FIXTURES.refunded(paymentIntentId, 'evt_fixture_refunded_2')))).toMatchObject({ applied: true, from: 'failed', to: 'refunded' });
  });

  it('cancels the team\'s other unfinished payments at the provider once one of them pays', async () => {
    const cancelledRefs: string[] = [];
    const recording: DonationProvider = {
      name: 'stripe',
      createPayment: () => Promise.reject(new Error('not used here')),
      cancelPayment: async (providerRef) => {
        await Promise.resolve();
        if (providerRef === 'pi_refuses') throw new DonationProviderError('stripe', 'Stripe returned 400: already canceled', 400);
        cancelledRefs.push(providerRef);
      },
    };
    resetAppContext({ donationProvider: recording, env: { ...env(), stripe: { secretKey: 'sk_test_fixture', webhookSecret: WEBHOOK_SECRET } } });
    const [lapsed] = await database.db
      .insert(donations)
      .values({ id: newId('don'), tournamentId, teamId, userId: captain.id, amountCents: 5000n, currency: 'USD', provider: 'stripe', providerRef: 'pi_lapsed', status: 'pending' })
      .returning();
    const [failed] = await database.db
      .insert(donations)
      .values({ id: newId('don'), tournamentId, teamId, userId: captain.id, amountCents: 5000n, currency: 'USD', provider: 'stripe', providerRef: 'pi_refuses', status: 'failed' })
      .returning();
    const [unstarted] = await database.db
      .insert(donations)
      .values({ id: newId('don'), tournamentId, teamId, userId: captain.id, amountCents: 5000n, currency: 'USD', provider: 'stripe', providerRef: 'pending:never-reached-stripe', status: 'pending' })
      .returning();

    const confirmed = await data<{ registration: string; cancelledDonationIds: string[] }>(await deliver(FIXTURES.succeeded(paymentIntentId)));
    expect(confirmed).toMatchObject({ applied: true, registration: 'confirmed', cancelledDonationIds: [lapsed?.id] });
    expect(cancelledRefs).toEqual(['pi_lapsed']);
    // The refusal is logged, not fatal; local rows wait for Stripe's own events.
    const rows = await database.db.select().from(donations).where(eq(donations.teamId, teamId));
    expect(rows.find((d) => d.id === lapsed?.id)?.status).toBe('pending');
    expect(rows.find((d) => d.id === failed?.id)?.status).toBe('failed');
    expect(rows.find((d) => d.id === unstarted?.id)?.status).toBe('pending');
    // Nothing is cancelled on a delivery that confirms nothing.
    expect(await data(await deliver(FIXTURES.succeeded(paymentIntentId, 'evt_fixture_succeeded_2')))).toMatchObject({ applied: false, reason: 'no_transition', cancelledDonationIds: [] });
    expect(cancelledRefs).toEqual(['pi_lapsed']);
  });

  it('does not accept anything when Stripe is not configured', async () => {
    resetAppContext();
    const response = await deliver(FIXTURES.succeeded(paymentIntentId));
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('stripe_not_configured');
  });
});
