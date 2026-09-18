import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { GET as me } from '../../src/app/api/me/route';
import { POST as joinTeam } from '../../src/app/api/teams/[id]/join/route';
import { POST as createTeam } from '../../src/app/api/teams/route';
import { GET as getImpact } from '../../src/app/api/tournaments/[slug]/impact/route';
import { POST as register } from '../../src/app/api/tournaments/[slug]/register/route';
import { GET as getTournament } from '../../src/app/api/tournaments/[slug]/route';
import { auditLog, donations, teams, type Charity, type User } from '../../src/db/schema';
import { logger } from '../../src/lib/logger';
import { resetAppContext } from '../../src/server/context';
import { DEV_SETTLE_DELAY_MS, settleDueDevDonations } from '../../src/server/donations/dev';
import { DonationProviderError, type DonationProvider } from '../../src/server/donations/provider';
import { applyStripeEvent } from '../../src/server/donations/service';
import { stripeEventSchema } from '../../src/server/donations/stripe';
import { countedTeams, type ReservationClock } from '../../src/server/field';
import type { PublicTournamentDetail } from '../../src/server/public-shape';
import { actorFor } from '../../src/server/actor';
import { runDraw } from '../../src/server/draw';
import { meSnapshot, type MeSnapshot } from '../../src/server/me';
import { purseContestEntryNotWired, registerTeam as registerTeamService } from '../../src/server/registration';
import { listPublicTournaments, tournamentDetail, updateTournament } from '../../src/server/tournaments';
import { cookieFor, createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { tournamentBody } from './tournaments.test';

type TeamResponse = { team: { id: string; name: string; status: string; invitedPhone?: string | null }; members: Array<{ userId: string; role: string }> };
type RegistrationResponse = {
  team: { id: string; status: string; registeredAt: string | null };
  donation: { id: string; amountCents: string; currency: string; provider: string; status: string } | null;
  reservationExpiresAt: string | null;
  clientSecret: string | null;
  purseEntry: { status: string };
};

const TTL_MS = 30 * 60_000;
const MINUTE = 60_000;

/** A Stripe-shaped provider that never reaches the network: the intent id is derived from the donation id, cancellations are recorded. */
const cancelled: string[] = [];
const stripeLike: DonationProvider = {
  name: 'stripe',
  createPayment: async (req) => {
    await Promise.resolve();
    return { providerRef: `pi_${req.donationId}`, clientSecret: `pi_${req.donationId}_secret`, status: 'pending' };
  },
  cancelPayment: async (providerRef) => {
    await Promise.resolve();
    cancelled.push(providerRef);
  },
};

const succeededEvent = (paymentIntentId: string) =>
  stripeEventSchema.parse({ id: `evt_${paymentIntentId}_ok`, type: 'payment_intent.succeeded', data: { object: { id: paymentIntentId, object: 'payment_intent' } } });
const refundedEvent = (paymentIntentId: string) =>
  stripeEventSchema.parse({
    id: `evt_${paymentIntentId}_refund`,
    type: 'charge.refunded',
    data: { object: { id: `ch_${paymentIntentId}`, object: 'charge', payment_intent: paymentIntentId, amount_refunded: 5000, refunded: true } },
  });

describe('teams and registration', () => {
  let database: Database;
  let organizer: User;
  let captain: User;
  let partner: User;
  let charity: Charity;
  let slug: string;
  let tournamentId: string;

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    organizer = await createUser(database, { role: 'organizer' });
    captain = await createUser(database, { displayName: 'Maya Delgado' });
    partner = await createUser(database, { displayName: 'Tomas Okafor' });
    charity = await createCharity(database);
    const created = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(request('POST', '/api/admin/tournaments', { body: tournamentBody(charity, { maxTeams: 2 }), cookie: cookieFor(organizer) })),
    );
    slug = created.tournament.slug;
    tournamentId = created.tournament.id;
    await patchTournament(request('PATCH', '/x', { body: { status: 'registration_open' }, cookie: cookieFor(organizer) }), params({ id: tournamentId }));
  });
  afterAll(async () => {
    await database.close();
  });

  const newTeam = (user: User, body: Record<string, unknown>) => createTeam(request('POST', '/api/teams', { body, cookie: cookieFor(user) }));
  const join = (user: User, id: string) => joinTeam(request('POST', `/api/teams/${id}/join`, { cookie: cookieFor(user) }), params({ id }));
  const registerTeam = (user: User, teamId: string, forSlug = slug) =>
    register(request('POST', `/api/tournaments/${forSlug}/register`, { body: { teamId }, cookie: cookieFor(user) }), params({ slug: forSlug }));

  it('creates a forming team, invites the partner by phone, and the partner joins', async () => {
    const created = await newTeam(captain, { tournamentSlug: slug, name: 'Delgado / Okafor', partnerPhone: partner.phoneE164 });
    expect(created.status).toBe(201);
    const { team, members } = await data<TeamResponse>(created);
    expect(team).toMatchObject({ status: 'forming', invitedPhone: partner.phoneE164 });
    expect(members).toEqual([{ userId: captain.id, role: 'captain' }]);

    // The invite shows up for the partner, not for a stranger.
    const partnerMe = await data<MeSnapshot>(await me(request('GET', '/api/me', { cookie: cookieFor(partner) })));
    expect(partnerMe.invites.map((i) => i.teamId)).toEqual([team.id]);
    expect(partnerMe.invites[0]).toMatchObject({ teamName: 'Delgado / Okafor', captain: 'Maya Delgado' });
    const stranger = await createUser(database);
    const strangerMe = await data<MeSnapshot>(await me(request('GET', '/api/me', { cookie: cookieFor(stranger) })));
    expect(strangerMe.invites).toEqual([]);

    const wrongPhone = await join(stranger, team.id);
    expect(wrongPhone.status).toBe(403);
    expect((await errorOf(wrongPhone)).code).toBe('not_invited');

    const joined = await data<TeamResponse>(await join(partner, team.id));
    expect(joined.members.map((m) => m.role).sort()).toEqual(['captain', 'player']);
    const again = await join(partner, team.id);
    expect((await errorOf(again)).code).toBe('already_member');

    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, team.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(trail.map((a) => [a.action, a.actorKind, a.actorUserId])).toEqual([
      ['team.created', 'player', captain.id],
      ['team.member_joined', 'player', partner.id],
    ]);

    // Forming teams are not public.
    const detail = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug })));
    expect(detail.teams).toEqual([]);
    expect(detail.teamCount).toBe(0);
  });

  it('refuses self-invites, unknown tournaments, teams in closed tournaments, and needs a session', async () => {
    expect((await createTeam(request('POST', '/api/teams', { body: { tournamentSlug: slug, name: 'Anon Pair', partnerPhone: '+14155550999' } }))).status).toBe(401);
    const self = await newTeam(captain, { tournamentSlug: slug, name: 'Solo', partnerPhone: captain.phoneE164 });
    expect((await errorOf(self)).code).toBe('partner_is_self');
    const unknown = await newTeam(partner, { tournamentSlug: 'nope', name: 'Ghost Pair', partnerPhone: captain.phoneE164 });
    expect(unknown.status).toBe(404);

    await patchTournament(request('PATCH', '/x', { body: { status: 'registration_closed' }, cookie: cookieFor(organizer) }), params({ id: tournamentId }));
    const closed = await newTeam(partner, { tournamentSlug: slug, name: 'Late', partnerPhone: captain.phoneE164 });
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).code).toBe('registration_not_open');
  });

  it('lets a captain recover from a mistyped invite by creating the team again, until the team is registered', async () => {
    const wrongNumber = '+14155550999';
    const { team: mistyped } = await data<TeamResponse>(await newTeam(captain, { tournamentSlug: slug, name: 'Delgado / ?', partnerPhone: wrongNumber }));
    const cannotJoin = await join(partner, mistyped.id);
    expect((await errorOf(cannotJoin)).code).toBe('not_invited');

    const retried = await newTeam(captain, { tournamentSlug: slug, name: 'Delgado / Okafor', partnerPhone: partner.phoneE164 });
    expect(retried.status).toBe(201);
    const { team } = await data<TeamResponse>(retried);
    expect(team.id).not.toBe(mistyped.id);
    const [old] = await database.db.select().from(teams).where(eq(teams.id, mistyped.id));
    expect(old).toMatchObject({ status: 'withdrawn', invitedPhoneE164: null });
    const oldTrail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, mistyped.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(oldTrail.map((a) => [a.action, a.actorUserId])).toEqual([
      ['team.created', captain.id],
      ['team.invite_revoked', captain.id],
      ['team.status_changed', captain.id],
    ]);
    expect(oldTrail[1]?.detail).toMatchObject({ invitedPhoneE164: wrongNumber, reason: 'superseded' });
    expect(oldTrail[2]?.detail).toMatchObject({ from: 'forming', to: 'withdrawn', reason: 'superseded' });

    // The partner sees only the live invite; a player on a forming team cannot start their own.
    const partnerMe = await data<MeSnapshot>(await me(request('GET', '/api/me', { cookie: cookieFor(partner) })));
    expect(partnerMe.invites.map((i) => i.teamId)).toEqual([team.id]);
    await join(partner, team.id);
    const partnersOwn = await newTeam(partner, { tournamentSlug: slug, name: 'Okafor / Someone', partnerPhone: '+14155550998' });
    expect((await errorOf(partnersOwn)).code).toBe('already_on_team');

    // Once registered, the captain's team is final.
    expect((await registerTeam(captain, team.id)).status).toBe(201);
    const third = await newTeam(captain, { tournamentSlug: slug, name: 'Three', partnerPhone: '+14155550997' });
    expect(third.status).toBe(409);
    expect((await errorOf(third)).code).toBe('already_on_team');
    expect((await database.db.select().from(teams).where(eq(teams.id, team.id)))[0]?.status).toBe('registered');
  });

  it('registers a complete team through the dev donation provider, which settles on the clock', async () => {
    const { team } = await data<TeamResponse>(await newTeam(captain, { tournamentSlug: slug, name: 'Delgado / Okafor', partnerPhone: partner.phoneE164 }));

    const incomplete = await registerTeam(captain, team.id);
    expect(incomplete.status).toBe(409);
    expect((await errorOf(incomplete)).code).toBe('team_incomplete');

    await join(partner, team.id);
    const notCaptain = await registerTeam(partner, team.id);
    expect(notCaptain.status).toBe(403);
    expect((await errorOf(notCaptain)).code).toBe('captain_required');

    const response = await registerTeam(captain, team.id);
    expect(response.status).toBe(201);
    const result = await data<RegistrationResponse>(response);
    expect(result.team).toMatchObject({ status: 'registered' });
    expect(result.team.registeredAt).not.toBeNull();
    expect(result.donation).toMatchObject({ amountCents: '5000', currency: 'USD', provider: 'dev', status: 'pending' });
    expect(result.clientSecret).toBeNull();
    expect(result.purseEntry).toEqual({ status: 'not_wired' });
    expect(new Date(result.reservationExpiresAt ?? '').getTime()).toBe(new Date(result.team.registeredAt ?? '').getTime() + TTL_MS);

    const [donation] = await database.db.select().from(donations).where(eq(donations.teamId, team.id));
    expect(donation?.providerRef).toMatch(/^dev_/);
    expect(donation?.status).toBe('pending');

    // Pending donations count for nothing on the impact tab...
    const before = await data<{ raisedCents: string; donationCount: number }>(await getImpact(request('GET', '/x'), params({ slug })));
    expect(before).toMatchObject({ raisedCents: '0', donationCount: 0 });
    // ...until the dev provider's delay elapses on the clock.
    expect(await settleDueDevDonations(database.db, { now: new Date(Date.now() + DEV_SETTLE_DELAY_MS - 1000), reservationTtlMs: TTL_MS })).toEqual([]);
    expect(await settleDueDevDonations(database.db, { now: new Date(Date.now() + DEV_SETTLE_DELAY_MS + 1000), reservationTtlMs: TTL_MS })).toEqual([donation?.id]);
    const after = await data<{ raisedCents: string; donationCount: number; progressPercent: number; donors: Array<{ displayName: string | null }> }>(
      await getImpact(request('GET', '/x'), params({ slug })),
    );
    expect(after).toMatchObject({ raisedCents: '5000', donationCount: 1, progressPercent: 1 });
    expect(after.donors[0]?.displayName).toBe('Maya Delgado');

    const twice = await registerTeam(captain, team.id);
    expect((await errorOf(twice)).code).toBe('already_registered');

    const detail = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug })));
    expect(detail.teamCount).toBe(1);
    expect(detail.teams[0]?.members.map((m) => m.displayName)).toEqual(['Maya Delgado', 'Tomas Okafor']);

    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, team.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(trail.map((a) => a.action)).toEqual(['team.created', 'team.member_joined', 'team.status_changed']);
    expect(trail[2]?.detail).toMatchObject({ from: 'forming', to: 'registered', reason: 'registration', donationId: donation?.id, purseEntry: 'not_wired' });
    const donationTrail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, donation?.id ?? '')).orderBy(auditLog.createdAt, auditLog.id);
    expect(donationTrail.map((a) => [a.action, a.actorKind])).toEqual([
      ['donation.created', 'player'],
      ['donation.succeeded', 'system'],
    ]);

    const mine = await data<MeSnapshot>(await me(request('GET', '/api/me', { cookie: cookieFor(captain) })));
    expect(mine.teams[0]?.team.status).toBe('registered');
    expect(mine.donations[0]).toMatchObject({ amountCents: '5000', status: 'succeeded', tournamentSlug: slug });
  });

  it('enforces capacity and the registration window', async () => {
    const pairs = [
      [captain, partner],
      [await createUser(database), await createUser(database)],
      [await createUser(database), await createUser(database)],
    ] as const;
    const ids: string[] = [];
    for (const [c, p] of pairs) {
      const { team } = await data<TeamResponse>(await newTeam(c, { tournamentSlug: slug, name: `${c.displayName} / ${p.displayName}`, partnerPhone: p.phoneE164 }));
      await join(p, team.id);
      ids.push(team.id);
    }
    expect((await registerTeam(pairs[0][0], ids[0] ?? '')).status).toBe(201);
    expect((await registerTeam(pairs[1][0], ids[1] ?? '')).status).toBe(201);
    const full = await registerTeam(pairs[2][0], ids[2] ?? '');
    expect(full.status).toBe(409);
    expect(await errorOf(full)).toMatchObject({ type: 'invalid_state', code: 'tournament_full' });

    await patchTournament(request('PATCH', '/x', { body: { maxTeams: 3 }, cookie: cookieFor(organizer) }), params({ id: tournamentId }));
    await database.db.update(teams).set({ status: 'withdrawn' }).where(eq(teams.id, ids[0] ?? ''));
    const past = new Date(Date.now() - 3600 * 1000);
    await database.db.update(teams).set({ status: 'registered' }).where(eq(teams.id, ids[0] ?? ''));
    await patchTournament(
      request('PATCH', '/x', { body: { startsAt: past.toISOString(), endsAt: new Date(past.getTime() + 1000).toISOString() }, cookie: cookieFor(organizer) }),
      params({ id: tournamentId }),
    );
    const late = await registerTeam(pairs[2][0], ids[2] ?? '');
    expect((await errorOf(late)).code).toBe('registration_window_closed');
  });

  it('registers for free when the entry donation is zero, with no donation row and no provider', async () => {
    resetAppContext({ donationProvider: null });
    await patchTournament(request('PATCH', '/x', { body: { status: 'draft' }, cookie: cookieFor(organizer) }), params({ id: tournamentId })).catch(() => undefined);
    const free = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(
        request('POST', '/api/admin/tournaments', { body: tournamentBody(charity, { slug: 'free-play', entryDonationCents: '0' }), cookie: cookieFor(organizer) }),
      ),
    );
    await patchTournament(request('PATCH', '/x', { body: { status: 'registration_open' }, cookie: cookieFor(organizer) }), params({ id: free.tournament.id }));
    const { team } = await data<TeamResponse>(await newTeam(captain, { tournamentSlug: 'free-play', name: 'Free', partnerPhone: partner.phoneE164 }));
    await join(partner, team.id);
    const result = await data<RegistrationResponse>(await registerTeam(captain, team.id, 'free-play'));
    expect(result.donation).toBeNull();
    expect(result.team.status).toBe('registered');
    expect(await database.db.select().from(donations)).toEqual([]);
  });

  it('refuses with donation_provider_unavailable when no provider is configured (production without Stripe)', async () => {
    resetAppContext({ donationProvider: null });
    const { team } = await data<TeamResponse>(await newTeam(captain, { tournamentSlug: slug, name: 'Test Pair', partnerPhone: partner.phoneE164 }));
    await join(partner, team.id);
    const response = await registerTeam(captain, team.id);
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ type: 'internal_error', code: 'donation_provider_unavailable' });
    const [row] = await database.db.select().from(teams).where(eq(teams.id, team.id));
    expect(row?.status).toBe('forming');
    expect(await database.db.select().from(donations)).toEqual([]);
  });

  it('marks the donation failed and releases the spot when the provider errors, then allows a retry', async () => {
    let calls = 0;
    const flaky: DonationProvider = {
      name: 'stripe',
      createPayment: async (req) => {
        calls += 1;
        await Promise.resolve();
        if (calls === 1) throw new DonationProviderError('stripe', 'Stripe returned 500: boom', 500);
        return { providerRef: `pi_${req.donationId}`, clientSecret: 'pi_secret_test', status: 'pending' };
      },
      cancelPayment: () => Promise.resolve(),
    };
    resetAppContext({ donationProvider: flaky });
    const { team } = await data<TeamResponse>(await newTeam(captain, { tournamentSlug: slug, name: 'Test Pair', partnerPhone: partner.phoneE164 }));
    await join(partner, team.id);

    const failed = await registerTeam(captain, team.id);
    expect(failed.status).toBe(502);
    expect(await errorOf(failed)).toMatchObject({ type: 'internal_error', code: 'donation_provider_error' });
    const [row] = await database.db.select().from(teams).where(eq(teams.id, team.id));
    expect(row).toMatchObject({ status: 'forming', registeredAt: null });
    const [first] = await database.db.select().from(donations).where(eq(donations.teamId, team.id));
    expect(first?.status).toBe('failed');

    const retried = await data<RegistrationResponse>(await registerTeam(captain, team.id));
    expect(retried.team.status).toBe('registered');
    expect(retried.donation).toMatchObject({ provider: 'stripe', status: 'pending' });
    expect(retried.clientSecret).toBe('pi_secret_test');
    const rows = await database.db.select().from(donations).where(eq(donations.teamId, team.id));
    expect(rows.map((d) => d.status).sort()).toEqual(['failed', 'pending']);
    expect(rows.find((d) => d.status === 'pending')?.providerRef).toMatch(/^pi_don_/);
  });

  describe('unpaid reservations, under an injected clock', () => {
    /** The injected clock starts a minute past the wall clock, so it sorts after the rows the route handlers stamp. */
    let t0 = new Date();
    const at = (minutes: number): ReservationClock => ({ now: new Date(t0.getTime() + minutes * MINUTE), reservationTtlMs: TTL_MS });
    const deps = () => ({ db: database.db, provider: stripeLike, purseEntry: purseContestEntryNotWired, log: logger('error'), reservationTtlMs: TTL_MS });
    const reserve = (user: User, teamId: string, minutes: number) =>
      registerTeamService(deps(), { tournamentSlug: slug, teamId, user, requestId: `req-${minutes}`, now: at(minutes).now });
    const pay = (donationId: string, minutes: number) => applyStripeEvent(database.db, succeededEvent(`pi_${donationId}`), at(minutes));

    async function completeTeam(name: string): Promise<{ captain: User; teamId: string }> {
      const c = await createUser(database, { displayName: `${name} captain` });
      const p = await createUser(database, { displayName: `${name} partner` });
      const { team } = await data<TeamResponse>(await newTeam(c, { tournamentSlug: slug, name, partnerPhone: p.phoneE164 }));
      await join(p, team.id);
      return { captain: c, teamId: team.id };
    }

    beforeEach(() => {
      resetAppContext({ donationProvider: stripeLike });
      t0 = new Date(Date.now() + MINUTE);
      cancelled.length = 0;
    });

    it('holds the place for the TTL, then releases it without touching the donation', async () => {
      const a = await completeTeam('Alpha');
      const reserved = await reserve(a.captain, a.teamId, 0);
      expect(reserved.reservationExpiresAt).toEqual(at(30).now);
      expect(await countedTeams(database.db, tournamentId, at(29))).toBe(1);
      expect((await tournamentDetail(database.db, slug, at(29)))?.teams.map((t) => t.id)).toEqual([a.teamId]);
      expect(await countedTeams(database.db, tournamentId, at(30))).toBe(0);
      const detail = await tournamentDetail(database.db, slug, at(31));
      expect(detail?.teams).toEqual([]);
      expect(detail?.teamCount).toBe(0);
      expect((await listPublicTournaments(database.db, {}, at(31))).find((t) => t.slug === slug)?.teamCount).toBe(0);
      const [row] = await database.db.select().from(donations).where(eq(donations.id, reserved.donation?.id ?? ''));
      expect(row?.status).toBe('pending');
      expect((await database.db.select().from(teams).where(eq(teams.id, a.teamId)))[0]?.status).toBe('registered');

      // /me tells the captain (and the partner) the same thing, under the same clock.
      const expiresAt = at(30).now.toISOString();
      const before = await meSnapshot(database.db, a.captain, at(29));
      expect(before.teams[0]?.team).toMatchObject({ id: a.teamId, status: 'registered', holdsPlace: true, reservationExpiresAt: expiresAt });
      expect(before.donations[0]).toMatchObject({ id: reserved.donation?.id, status: 'pending', holdsPlace: true, reservationExpiresAt: expiresAt });
      const lapsed = await meSnapshot(database.db, a.captain, at(31));
      expect(lapsed.teams[0]?.team).toMatchObject({ id: a.teamId, status: 'registered', holdsPlace: false, reservationExpiresAt: expiresAt });
      expect(lapsed.donations[0]).toMatchObject({ status: 'pending', holdsPlace: false, reservationExpiresAt: expiresAt });

      // Paying within the TTL confirms the place for good.
      const b = await completeTeam('Bravo');
      const bravo = await reserve(b.captain, b.teamId, 0);
      expect(await pay(bravo.donation?.id ?? '', 5)).toMatchObject({ applied: true, registration: 'confirmed', refundDue: null });
      expect(await countedTeams(database.db, tournamentId, at(500))).toBe(1);
      const paid = await meSnapshot(database.db, b.captain, at(500));
      expect(paid.teams[0]?.team).toMatchObject({ id: b.teamId, holdsPlace: true, reservationExpiresAt: null });
      expect(paid.donations[0]).toMatchObject({ status: 'succeeded', holdsPlace: true, reservationExpiresAt: null });
    });

    it('lets a lapsed reservation be taken by another team, and the lapsed captain register again', async () => {
      const a = await completeTeam('Alpha');
      const b = await completeTeam('Bravo');
      const c = await completeTeam('Charlie');
      const alpha = await reserve(a.captain, a.teamId, 0);
      await reserve(b.captain, b.teamId, 0);
      await expect(reserve(c.captain, c.teamId, 10)).rejects.toMatchObject({ error: { code: 'tournament_full' } });
      await expect(reserve(a.captain, a.teamId, 10)).rejects.toMatchObject({ error: { code: 'already_registered' } });

      // Alpha and Bravo lapse; Charlie takes a place, and Alpha reserves again with a fresh payment.
      const charlie = await reserve(c.captain, c.teamId, 31);
      expect(charlie.team.status).toBe('registered');
      const alphaAgain = await reserve(a.captain, a.teamId, 32);
      expect(alphaAgain.donation?.id).not.toBe(alpha.donation?.id);
      expect(alphaAgain.reservationExpiresAt).toEqual(at(62).now);
      expect(await countedTeams(database.db, tournamentId, at(33))).toBe(2);
      // The payment the new one replaces is cancelled at the provider; the local row waits for the provider's own event.
      expect(cancelled).toEqual([`pi_${alpha.donation?.id ?? ''}`]);
      expect((await database.db.select().from(donations).where(eq(donations.id, alpha.donation?.id ?? '')))[0]?.status).toBe('pending');
      const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, a.teamId)).orderBy(auditLog.createdAt, auditLog.id);
      expect(trail.map((x) => x.action)).toEqual(['team.created', 'team.member_joined', 'team.status_changed', 'team.reservation_renewed']);
      expect(trail[3]?.detail).toMatchObject({ from: 'registered', to: 'registered', donationId: alphaAgain.donation?.id });
    });

    it('honours a late payment while there is room, and withdraws the team with a refund due once the event is full', async () => {
      const a = await completeTeam('Alpha');
      const b = await completeTeam('Bravo');
      const c = await completeTeam('Charlie');
      const alpha = await reserve(a.captain, a.teamId, 0);
      const bravo = await reserve(b.captain, b.teamId, 0);
      const charlie = await reserve(c.captain, c.teamId, 31);
      expect(await pay(charlie.donation?.id ?? '', 32)).toMatchObject({ applied: true, registration: 'confirmed' });

      // Alpha's late payment still fits: two places, one taken.
      expect(await pay(alpha.donation?.id ?? '', 33)).toMatchObject({ applied: true, from: 'pending', to: 'succeeded', registration: 'confirmed' });
      expect((await database.db.select().from(teams).where(eq(teams.id, a.teamId)))[0]?.status).toBe('registered');
      expect(await countedTeams(database.db, tournamentId, at(34))).toBe(2);

      // Bravo's does not: the money stays, the team goes, and the organizer is told what to refund.
      expect(await pay(bravo.donation?.id ?? '', 35)).toMatchObject({ applied: true, from: 'pending', to: 'succeeded', registration: 'withdrawn', refundDue: 'event_full' });
      const [bravoDonation] = await database.db.select().from(donations).where(eq(donations.id, bravo.donation?.id ?? ''));
      expect(bravoDonation?.status).toBe('succeeded');
      expect((await database.db.select().from(teams).where(eq(teams.id, b.teamId)))[0]?.status).toBe('withdrawn');
      const refundDue = await database.db.select().from(auditLog).where(eq(auditLog.action, 'donation.refund_due'));
      expect(refundDue).toHaveLength(1);
      expect(refundDue[0]).toMatchObject({ actorKind: 'system', subjectType: 'donation', subjectId: bravo.donation?.id });
      expect(refundDue[0]?.detail).toMatchObject({
        reason: 'event_full',
        teamId: b.teamId,
        teamStatus: 'registered',
        tournamentId,
        tournamentStatus: 'registration_open',
        amountCents: '5000',
        currency: 'USD',
        provider: 'stripe',
        providerRef: `pi_${bravo.donation?.id ?? ''}`,
      });
      const bravoTrail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, b.teamId)).orderBy(auditLog.createdAt, auditLog.id);
      expect(bravoTrail.at(-1)?.detail).toMatchObject({ from: 'registered', to: 'withdrawn', reason: 'event_full', donationId: bravo.donation?.id });
      expect(await countedTeams(database.db, tournamentId, at(36))).toBe(2);
      const detail = await tournamentDetail(database.db, slug, at(36));
      expect(detail?.teams.map((t) => t.id).sort()).toEqual([a.teamId, c.teamId].sort());
    });

    it('withdraws a team whose late payment lands once the field is fixed, with the refund named', async () => {
      const actor = actorFor(organizer);
      await updateTournament(database.db, tournamentId, { maxTeams: 3 }, actor, at(0));
      const a = await completeTeam('Alpha');
      const b = await completeTeam('Bravo');
      const c = await completeTeam('Charlie');
      const alpha = await reserve(a.captain, a.teamId, 0);
      const bravo = await reserve(b.captain, b.teamId, 1);
      const charlie = await reserve(c.captain, c.teamId, 1);
      await pay(bravo.donation?.id ?? '', 2);
      await pay(charlie.donation?.id ?? '', 2);

      // Alpha lapses; the organizer closes, draws the paid teams, and goes live without it.
      await updateTournament(database.db, tournamentId, { status: 'registration_closed' }, actor, at(31));
      const drawn = await runDraw(database.db, { tournamentId, request: { stage: 'pools', poolSize: 2, courts: 1 }, preview: false, actor, now: at(32).now });
      expect(drawn.pools.flatMap((p) => p.teamIds).sort()).toEqual([b.teamId, c.teamId].sort());
      const live = await updateTournament(database.db, tournamentId, { status: 'live' }, actor, at(33));
      expect(live.transition?.to).toBe('live');

      // Room is not the question any more: the draw is fixed.
      expect(await pay(alpha.donation?.id ?? '', 40)).toMatchObject({ applied: true, to: 'succeeded', registration: 'withdrawn', refundDue: 'registration_closed' });
      expect((await database.db.select().from(teams).where(eq(teams.id, a.teamId)))[0]?.status).toBe('withdrawn');
      expect((await database.db.select().from(donations).where(eq(donations.id, alpha.donation?.id ?? '')))[0]?.status).toBe('succeeded');
      const refundDue = await database.db.select().from(auditLog).where(eq(auditLog.action, 'donation.refund_due'));
      expect(refundDue).toHaveLength(1);
      expect(refundDue[0]?.detail).toMatchObject({ reason: 'registration_closed', tournamentStatus: 'live', teamId: a.teamId, providerRef: `pi_${alpha.donation?.id ?? ''}` });
      expect(await countedTeams(database.db, tournamentId, at(41))).toBe(2);
    });

    it('never confirms a payment for a team that already withdrew, and never counts one entry twice', async () => {
      const a = await completeTeam('Alpha');
      const first = await reserve(a.captain, a.teamId, 0);
      const firstId = first.donation?.id ?? '';
      // The reservation lapses; the captain registers again and pays the replacement.
      const second = await reserve(a.captain, a.teamId, 31);
      const secondId = second.donation?.id ?? '';
      expect(await pay(secondId, 32)).toMatchObject({ applied: true, registration: 'confirmed', refundDue: null });

      // The first payment lands anyway: the entry is already paid for.
      expect(await pay(firstId, 33)).toMatchObject({ applied: true, to: 'succeeded', registration: 'unchanged', refundDue: 'duplicate_payment' });
      expect((await database.db.select().from(teams).where(eq(teams.id, a.teamId)))[0]?.status).toBe('registered');
      expect((await database.db.select().from(donations).where(eq(donations.teamId, a.teamId))).map((d) => d.status)).toEqual(['succeeded', 'succeeded']);
      const duplicate = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'donation.refund_due'), eq(auditLog.subjectId, firstId)));
      expect(duplicate[0]?.detail).toMatchObject({ reason: 'duplicate_payment', teamId: a.teamId, teamStatus: 'registered' });
      expect(await countedTeams(database.db, tournamentId, at(34))).toBe(1);

      // Refunding the duplicate leaves the team in place: the other payment still pays for it.
      expect(await applyStripeEvent(database.db, refundedEvent(`pi_${firstId}`), at(35))).toMatchObject({ applied: true, to: 'refunded', registration: 'unchanged', refundDue: null });
      expect((await database.db.select().from(teams).where(eq(teams.id, a.teamId)))[0]?.status).toBe('registered');
      expect(await countedTeams(database.db, tournamentId, at(36))).toBe(1);

      // Refunding the one that pays withdraws the team; a payment that lands after that is refund due, not a place.
      expect(await applyStripeEvent(database.db, refundedEvent(`pi_${secondId}`), at(37))).toMatchObject({ applied: true, to: 'refunded', registration: 'withdrawn' });
      expect((await database.db.select().from(teams).where(eq(teams.id, a.teamId)))[0]?.status).toBe('withdrawn');
      const third = await completeTeam('Third');
      const late = await reserve(third.captain, third.teamId, 38);
      await database.db.update(teams).set({ status: 'withdrawn' }).where(eq(teams.id, third.teamId));
      expect(await pay(late.donation?.id ?? '', 39)).toMatchObject({ applied: true, to: 'succeeded', registration: 'unchanged', refundDue: 'team_withdrawn' });
      expect((await database.db.select().from(teams).where(eq(teams.id, third.teamId)))[0]?.status).toBe('withdrawn');
      const lateRefund = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'donation.refund_due'), eq(auditLog.subjectId, late.donation?.id ?? '')));
      expect(lateRefund[0]?.detail).toMatchObject({ reason: 'team_withdrawn', teamStatus: 'withdrawn', amountCents: '5000' });
      expect(await countedTeams(database.db, tournamentId, at(40))).toBe(0);
    });
  });
});
