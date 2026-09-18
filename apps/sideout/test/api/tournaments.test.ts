import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { GET as getImpact } from '../../src/app/api/tournaments/[slug]/impact/route';
import { GET as getTournament } from '../../src/app/api/tournaments/[slug]/route';
import { GET as getStandings } from '../../src/app/api/tournaments/[slug]/standings/route';
import { GET as listTournaments } from '../../src/app/api/tournaments/route';
import { auditLog, tournaments, type Charity, type User } from '../../src/db/schema';
import type { PublicTournament, PublicTournamentDetail } from '../../src/server/public-shape';
import {
  cookieFor,
  createCharity,
  createUser,
  data,
  errorOf,
  expectNoPurseKeys,
  params,
  request,
  testDatabase,
  truncateAll,
  type Database,
} from '../helpers';

const SOON = new Date(Date.now() + 14 * 24 * 3600 * 1000);

export function tournamentBody(charity: Charity, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'sandbar-classic-2027',
    name: 'Sandbar Classic',
    subtitle: 'The flagship',
    beneficiaryId: charity.id,
    venue: { name: 'Sandbar Courts', city: 'Santa Cruz', region: 'CA', timezone: 'America/Los_Angeles' },
    startsAt: SOON.toISOString(),
    endsAt: new Date(SOON.getTime() + 8 * 3600 * 1000).toISOString(),
    format: 'pool_to_bracket',
    division: 'open',
    maxTeams: 24,
    entryDonationCents: '5000',
    fundraisingGoalCents: '500000',
    ...overrides,
  };
}

type AdminTournament = { tournament: PublicTournament & { drawConfig: unknown }; changedFields?: string[]; transition?: { from: string; to: string } | null };

describe('organizer tournaments', () => {
  let database: Database;
  let organizer: User;
  let player: User;
  let charity: Charity;
  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    organizer = await createUser(database, { role: 'organizer' });
    player = await createUser(database, { role: 'player' });
    charity = await createCharity(database);
  });
  afterAll(async () => {
    await database.close();
  });

  const create = (body: Record<string, unknown>, cookie?: string) =>
    createTournament(request('POST', '/api/admin/tournaments', { body, cookie: cookie ?? cookieFor(organizer) }));
  const patch = (id: string, body: Record<string, unknown>, cookie?: string) =>
    patchTournament(request('PATCH', `/api/admin/tournaments/${id}`, { body, cookie: cookie ?? cookieFor(organizer) }), params({ id }));

  it('creates a draft with an opaque Purse external id, audited, and keeps it out of the public list', async () => {
    const response = await create(tournamentBody(charity));
    expect(response.status).toBe(201);
    const { tournament } = await data<AdminTournament>(response);
    expect(tournament).toMatchObject({ slug: 'sandbar-classic-2027', status: 'draft', entryDonationCents: '5000', fundraisingGoalCents: '500000', teamCount: 0 });
    expect(tournament.beneficiary).toMatchObject({ id: charity.id, slug: charity.slug });
    expectNoPurseKeys(tournament);

    const [row] = await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    expect(row?.purseExternalId).toMatch(/^sideout-contest-[0-9a-f]{32}$/);
    expect(row?.purseContestId).toBeNull();
    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id));
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'tournament.created', actorKind: 'organizer', actorUserId: organizer.id });

    const listed = await data<{ tournaments: PublicTournament[] }>(await listTournaments(request('GET', '/api/tournaments')));
    expect(listed.tournaments).toEqual([]);
    const detail = await getTournament(request('GET', '/api/tournaments/sandbar-classic-2027'), params({ slug: 'sandbar-classic-2027' }));
    expect(detail.status).toBe(404);
    expect((await errorOf(detail)).code).toBe('tournament_not_found');
    expect((await getStandings(request('GET', '/x'), params({ slug: 'sandbar-classic-2027' }))).status).toBe(404);
    expect((await getImpact(request('GET', '/x'), params({ slug: 'sandbar-classic-2027' }))).status).toBe(404);
  });

  it('gates the admin routes on a signed-in organizer', async () => {
    const anonymous = await createTournament(request('POST', '/api/admin/tournaments', { body: tournamentBody(charity) }));
    expect(anonymous.status).toBe(401);
    expect(await errorOf(anonymous)).toMatchObject({ type: 'authentication_error', code: 'sign_in_required' });

    const asPlayer = await create(tournamentBody(charity), cookieFor(player));
    expect(asPlayer.status).toBe(403);
    expect(await errorOf(asPlayer)).toMatchObject({ type: 'permission_error', code: 'organizer_required' });

    const patched = await patch('trn_nope', { name: 'x' }, cookieFor(player));
    expect(patched.status).toBe(403);
  });

  it('rejects bad input, unknown beneficiaries and duplicate slugs with the envelope', async () => {
    const invalid = await create(tournamentBody(charity, { slug: 'Not A Slug', maxTeams: 1 }));
    expect(invalid.status).toBe(400);
    const error = await errorOf(invalid);
    expect(error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });
    expect(JSON.stringify(error.detail)).toMatch(/slug/);

    const badZone = await create(tournamentBody(charity, { venue: { name: 'x', city: 'y', region: 'z', timezone: 'Mars/Olympus' } }));
    expect(badZone.status).toBe(400);

    const backwards = await create(tournamentBody(charity, { endsAt: new Date(SOON.getTime() - 1000).toISOString() }));
    expect(backwards.status).toBe(400);

    const unknownCharity = await create(tournamentBody(charity, { beneficiaryId: 'chr_00000000-0000-7000-8000-000000000000' }));
    expect((await errorOf(unknownCharity)).code).toBe('beneficiary_unknown');

    // Cents are decimal strings on the wire; a JSON number never enters the money path.
    const numericCents = await create(tournamentBody(charity, { fundraisingGoalCents: 500000 }));
    expect(numericCents.status).toBe(400);
    expect(JSON.stringify((await errorOf(numericCents)).detail)).toMatch(/fundraisingGoalCents/);

    // Only formats the engine can draw are offered.
    const undrawable = await create(tournamentBody(charity, { format: 'double_elim' }));
    expect(undrawable.status).toBe(400);
    expect(JSON.stringify((await errorOf(undrawable)).detail)).toMatch(/format/);

    expect((await create(tournamentBody(charity))).status).toBe(201);
    const duplicate = await create(tournamentBody(charity));
    expect(duplicate.status).toBe(409);
    expect(await errorOf(duplicate)).toMatchObject({ type: 'conflict', code: 'slug_taken' });
  });

  it('walks the state machine with audit rows, refuses illegal moves, and reserves settled for the system', async () => {
    const { tournament } = await data<AdminTournament>(await create(tournamentBody(charity)));

    const skip = await patch(tournament.id, { status: 'live' });
    expect(skip.status).toBe(409);
    expect(await errorOf(skip)).toMatchObject({ type: 'invalid_state', code: 'transition_not_a_transition' });

    const opened = await data<AdminTournament>(await patch(tournament.id, { status: 'registration_open' }));
    expect(opened.transition).toEqual({ from: 'draft', to: 'registration_open' });
    expect(opened.tournament.status).toBe('registration_open');

    const same = await patch(tournament.id, { status: 'registration_open' });
    expect((await errorOf(same)).code).toBe('transition_same_state');

    // Now public.
    const listed = await data<{ tournaments: PublicTournament[] }>(await listTournaments(request('GET', '/api/tournaments')));
    expect(listed.tournaments.map((t) => t.slug)).toEqual(['sandbar-classic-2027']);
    const filtered = await data<{ tournaments: PublicTournament[] }>(await listTournaments(request('GET', '/api/tournaments?status=live')));
    expect(filtered.tournaments).toEqual([]);
    const badFilter = await listTournaments(request('GET', '/api/tournaments?status=draft'));
    expect(badFilter.status).toBe(400);

    const closed = await data<AdminTournament>(await patch(tournament.id, { status: 'registration_closed' }));
    expect(closed.transition?.to).toBe('registration_closed');

    const liveWithoutDraw = await patch(tournament.id, { status: 'live' });
    expect(liveWithoutDraw.status).toBe(409);
    expect((await errorOf(liveWithoutDraw)).code).toBe('draw_required');

    const reopened = await data<AdminTournament>(await patch(tournament.id, { status: 'registration_open' }));
    expect(reopened.transition?.to).toBe('registration_open');

    const settled = await patch(tournament.id, { status: 'settled' });
    expect(settled.status).toBe(409);
    expect((await errorOf(settled)).code).toBe('transition_not_a_transition');

    const cancelled = await data<AdminTournament>(await patch(tournament.id, { status: 'cancelled' }));
    expect(cancelled.tournament.status).toBe('cancelled');
    const afterCancel = await patch(tournament.id, { status: 'draft' });
    expect((await errorOf(afterCancel)).code).toBe('transition_terminal_state');
    const editCancelled = await patch(tournament.id, { name: 'Renamed' });
    expect((await errorOf(editCancelled)).code).toBe('tournament_closed');

    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(trail.map((a) => a.action)).toEqual([
      'tournament.created',
      'tournament.status_changed',
      'tournament.status_changed',
      'tournament.status_changed',
      'tournament.status_changed',
    ]);
    expect(trail.map((a) => a.detail)).toEqual([
      expect.objectContaining({ slug: 'sandbar-classic-2027' }),
      { from: 'draft', to: 'registration_open' },
      { from: 'registration_open', to: 'registration_closed' },
      { from: 'registration_closed', to: 'registration_open' },
      { from: 'registration_open', to: 'cancelled' },
    ]);
    expect(trail.every((a) => a.actorKind === 'organizer' && a.actorUserId === organizer.id)).toBe(true);
  });

  it('edits fields with an audit row, and locks the structural ones after draft', async () => {
    const { tournament } = await data<AdminTournament>(await create(tournamentBody(charity)));
    const edited = await data<AdminTournament>(await patch(tournament.id, { name: 'Sandbar Classic II', maxTeams: 32, entryDonationCents: '2500' }));
    expect(edited.changedFields?.sort()).toEqual(['entryDonationCents', 'maxTeams', 'name']);
    expect(edited.tournament).toMatchObject({ name: 'Sandbar Classic II', maxTeams: 32, entryDonationCents: '2500' });
    expect((await patch(tournament.id, { entryDonationCents: 2500 })).status).toBe(400);
    expect((await patch(tournament.id, { format: 'double_elim' })).status).toBe(400);

    await patch(tournament.id, { status: 'registration_open' });
    const locked = await patch(tournament.id, { format: 'single_elim' });
    expect(locked.status).toBe(409);
    expect(await errorOf(locked)).toMatchObject({ code: 'draft_only_fields', detail: { fields: ['format'] } });
    const stillEditable = await data<AdminTournament>(await patch(tournament.id, { subtitle: null, maxTeams: 16 }));
    expect(stillEditable.tournament.subtitle).toBeNull();

    const empty = await patch(tournament.id, {});
    expect(empty.status).toBe(400);
    const missing = await patch('trn_00000000-0000-7000-8000-000000000000', { name: 'ghost' });
    expect(missing.status).toBe(404);

    const trail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id));
    expect(trail.filter((a) => a.action === 'tournament.updated')).toHaveLength(2);
  });

  it('lists events still ahead soonest first, then events that are over most recent first', async () => {
    const day = 24 * 3600 * 1000;
    const at = (days: number) => ({ startsAt: new Date(Date.now() + days * day).toISOString(), endsAt: new Date(Date.now() + days * day + 3600 * 1000).toISOString() });
    const make = async (slug: string, days: number, status: 'registration_open' | 'cancelled') => {
      const { tournament } = await data<AdminTournament>(await create(tournamentBody(charity, { slug, ...at(days) })));
      await patch(tournament.id, { status: 'registration_open' });
      if (status === 'cancelled') await patch(tournament.id, { status: 'cancelled' });
      return tournament.id;
    };
    const farAhead = await make('far-ahead', 21, 'registration_open');
    const overLongAgo = await make('over-long-ago', -30, 'cancelled');
    const nextUp = await make('next-up', 3, 'registration_open');
    const overLately = await make('over-lately', -2, 'cancelled');
    const aheadButOver = await make('ahead-but-over', 10, 'cancelled');
    await create(tournamentBody(charity, { slug: 'still-a-draft', ...at(1) }));

    const listed = await data<{ tournaments: PublicTournament[] }>(await listTournaments(request('GET', '/api/tournaments')));
    expect(listed.tournaments.map((t) => t.id)).toEqual([nextUp, farAhead, aheadButOver, overLately, overLongAgo]);
    const cancelledOnly = await data<{ tournaments: PublicTournament[] }>(await listTournaments(request('GET', '/api/tournaments?status=cancelled')));
    expect(cancelledOnly.tournaments.map((t) => t.id)).toEqual([aheadButOver, overLately, overLongAgo]);
  });

  it('serves the public detail, standings and impact for an open tournament without Purse identifiers', async () => {
    const { tournament } = await data<AdminTournament>(await create(tournamentBody(charity)));
    await patch(tournament.id, { status: 'registration_open' });

    const detail = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug: tournament.slug })));
    expect(detail).toMatchObject({ slug: tournament.slug, status: 'registration_open', teams: [], pools: [], bracket: null, sponsors: [] });
    expectNoPurseKeys(detail);

    const standings = await getStandings(request('GET', '/x'), params({ slug: tournament.slug }));
    expect(standings.headers.get('cache-control')).toBe('public, max-age=10, stale-while-revalidate=10');
    expect(await data(standings)).toMatchObject({ slug: tournament.slug, pools: [] });

    const impact = await data<{ raisedCents: string; goalCents: string; progressPercent: number; donationCount: number }>(
      await getImpact(request('GET', '/x'), params({ slug: tournament.slug })),
    );
    expect(impact).toMatchObject({ raisedCents: '0', goalCents: '500000', progressPercent: 0, donationCount: 0 });
    expectNoPurseKeys(impact);
  });
});
