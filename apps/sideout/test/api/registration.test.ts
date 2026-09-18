import { eq } from 'drizzle-orm';
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
import { resetAppContext } from '../../src/server/context';
import { DEV_SETTLE_DELAY_MS, settleDueDevDonations } from '../../src/server/donations/dev';
import { DonationProviderError, type DonationProvider } from '../../src/server/donations/provider';
import type { MeSnapshot } from '../../src/server/me';
import type { PublicTournamentDetail } from '../../src/server/public-shape';
import { cookieFor, createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { tournamentBody } from './tournaments.test';

type TeamResponse = { team: { id: string; name: string; status: string; invitedPhone?: string | null }; members: Array<{ userId: string; role: string }> };
type RegistrationResponse = {
  team: { id: string; status: string; registeredAt: string | null };
  donation: { id: string; amountCents: string; currency: string; provider: string; status: string } | null;
  clientSecret: string | null;
  purseEntry: { status: string };
};

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

  it('refuses self-invites, second teams, teams in closed tournaments, and needs a session', async () => {
    expect((await createTeam(request('POST', '/api/teams', { body: { tournamentSlug: slug, name: 'Anon Pair', partnerPhone: '+14155550999' } }))).status).toBe(401);
    const self = await newTeam(captain, { tournamentSlug: slug, name: 'Solo', partnerPhone: captain.phoneE164 });
    expect((await errorOf(self)).code).toBe('partner_is_self');
    expect((await newTeam(captain, { tournamentSlug: slug, name: 'One', partnerPhone: partner.phoneE164 })).status).toBe(201);
    const second = await newTeam(captain, { tournamentSlug: slug, name: 'Two', partnerPhone: partner.phoneE164 });
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe('already_on_team');
    const unknown = await newTeam(partner, { tournamentSlug: 'nope', name: 'Ghost Pair', partnerPhone: captain.phoneE164 });
    expect(unknown.status).toBe(404);

    await patchTournament(request('PATCH', '/x', { body: { status: 'registration_closed' }, cookie: cookieFor(organizer) }), params({ id: tournamentId }));
    const closed = await newTeam(partner, { tournamentSlug: slug, name: 'Late', partnerPhone: captain.phoneE164 });
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).code).toBe('registration_not_open');
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

    const [donation] = await database.db.select().from(donations).where(eq(donations.teamId, team.id));
    expect(donation?.providerRef).toMatch(/^dev_/);
    expect(donation?.status).toBe('pending');

    // Pending donations count for nothing on the impact tab...
    const before = await data<{ raisedCents: string; donationCount: number }>(await getImpact(request('GET', '/x'), params({ slug })));
    expect(before).toMatchObject({ raisedCents: '0', donationCount: 0 });
    // ...until the dev provider's delay elapses on the clock.
    expect(await settleDueDevDonations(database.db, new Date(Date.now() + DEV_SETTLE_DELAY_MS - 1000))).toEqual([]);
    expect(await settleDueDevDonations(database.db, new Date(Date.now() + DEV_SETTLE_DELAY_MS + 1000))).toEqual([donation?.id]);
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
        request('POST', '/api/admin/tournaments', { body: tournamentBody(charity, { slug: 'free-play', entryDonationCents: 0 }), cookie: cookieFor(organizer) }),
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
});
