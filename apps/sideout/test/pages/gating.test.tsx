import { newId } from '@repo/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { charities, tournaments, type Charity, type User } from '../../src/db/schema';
import { mintPurseExternalId } from '../../src/server/actor';
import { cookieFor, createCharity, createUser, testDatabase, truncateAll, type Database } from '../helpers';

/**
 * Role gating of the screens (spec 5.3): the console and `/admin/purse` are 404 for a
 * player or a visitor, the same as an unknown path; `/me`, `/teams/new` and a
 * registration page send a visitor to sign in and back; a draft event is invisible to
 * the public but an organizer may preview it. The pages are server components: they are
 * awaited here with the session cookie stubbed into `next/headers`, and `notFound` and
 * `redirect` are stubbed to throw sentinels.
 */
let cookie: string | null = null;

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers(cookie === null ? {} : { cookie })) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

const params = <P,>(value: P) => ({ params: Promise.resolve(value), searchParams: Promise.resolve({}) });

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'rendered';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('screen gating', () => {
  let database: Database;
  let charity: Charity;
  let player: User;
  let organizer: User;
  let draftId: string;

  beforeAll(async () => {
    database = testDatabase();
    await truncateAll(database);
    charity = await createCharity(database);
    player = await createUser(database, { displayName: 'Pat Player' });
    organizer = await createUser(database, { role: 'organizer', displayName: 'Ora Organizer' });
    const now = new Date();
    const [draft] = await database.db
      .insert(tournaments)
      .values({
        id: newId('trn'),
        slug: 'draft-event',
        name: 'Draft Event',
        beneficiaryId: charity.id,
        venueName: 'V',
        venueCity: 'C',
        venueRegion: 'R',
        venueTimezone: 'America/Los_Angeles',
        startsAt: new Date(now.getTime() + 86_400_000),
        endsAt: new Date(now.getTime() + 90_000_000),
        format: 'pool_to_bracket',
        division: 'open',
        maxTeams: 8,
        entryDonationCents: 4000n,
        fundraisingGoalCents: 100_000n,
        status: 'draft',
        purseExternalId: mintPurseExternalId('contest'),
      })
      .returning({ id: tournaments.id });
    draftId = draft!.id;
    expect((await database.db.select().from(charities)).length).toBe(1);
  });
  afterAll(async () => {
    await truncateAll(database);
    await database.close();
  });
  beforeEach(() => {
    cookie = null;
  });

  it('the console is 404 for a visitor and for a player, and renders for an organizer', async () => {
    const { default: EventsPage } = await import('../../src/app/organizer/events/page');
    const { default: Layout } = await import('../../src/app/organizer/layout');
    expect(await outcome(() => EventsPage())).toBe('NOT_FOUND');
    cookie = cookieFor(player);
    expect(await outcome(() => EventsPage())).toBe('NOT_FOUND');
    expect(await outcome(() => Layout({ children: null }))).toBe('NOT_FOUND');
    cookie = cookieFor(organizer);
    expect(await outcome(() => EventsPage())).toBe('rendered');
    expect(await outcome(() => Layout({ children: null }))).toBe('rendered');
  });

  it('the builder, the board, the close page, the dispute queue and /admin/purse are 404 to a player', async () => {
    cookie = cookieFor(player);
    const { default: Builder } = await import('../../src/app/organizer/events/[id]/page');
    const { default: Board } = await import('../../src/app/organizer/events/[id]/board/page');
    const { default: Close } = await import('../../src/app/organizer/events/[id]/close/page');
    const { default: Disputes } = await import('../../src/app/organizer/disputes/page');
    const { default: Admin } = await import('../../src/app/admin/purse/page');
    for (const run of [() => Builder(params({ id: draftId })), () => Board(params({ id: draftId })), () => Close(params({ id: draftId })), () => Disputes(), () => Admin(params({}))]) {
      expect(await outcome(run)).toBe('NOT_FOUND');
    }
    cookie = cookieFor(organizer);
    expect(await outcome(() => Builder(params({ id: draftId })))).toBe('rendered');
    expect(await outcome(() => Board(params({ id: draftId })))).toBe('rendered');
    expect(await outcome(() => Disputes())).toBe('rendered');
    expect(await outcome(() => Admin(params({})))).toBe('rendered');
    expect(await outcome(() => Builder(params({ id: 'trn_missing' })))).toBe('NOT_FOUND');
  });

  it('a visitor is sent to sign in and back from the profile, the team form and a registration page', async () => {
    const { default: Me } = await import('../../src/app/me/page');
    const { default: NewTeam } = await import('../../src/app/teams/new/page');
    expect(await outcome(() => Me())).toBe('REDIRECT:/sign-in?next=%2Fme');
    expect(await outcome(() => NewTeam({ searchParams: Promise.resolve({ t: 'x' }) }))).toBe('REDIRECT:/sign-in?next=%2Fteams%2Fnew%3Ft%3Dx');
    cookie = cookieFor(player);
    expect(await outcome(() => Me())).toBe('rendered');
    expect(await outcome(() => NewTeam({ searchParams: Promise.resolve({}) }))).toBe('rendered');
  });

  it('a draft event is 404 to the public and a preview for an organizer', async () => {
    const { default: Overview } = await import('../../src/app/t/[slug]/page');
    const { default: Register } = await import('../../src/app/t/[slug]/register/page');
    expect(await outcome(() => Overview(params({ slug: 'draft-event' })))).toBe('NOT_FOUND');
    cookie = cookieFor(player);
    expect(await outcome(() => Overview(params({ slug: 'draft-event' })))).toBe('NOT_FOUND');
    expect(await outcome(() => Register(params({ slug: 'draft-event' })))).toBe('NOT_FOUND');
    cookie = cookieFor(organizer);
    expect(await outcome(() => Overview(params({ slug: 'draft-event' })))).toBe('rendered');
    expect(await outcome(() => Overview(params({ slug: 'no-such-event' })))).toBe('NOT_FOUND');
  });

  it('the sign-in page bounces a signed-in visitor to the safe next path only', async () => {
    const { default: SignIn } = await import('../../src/app/sign-in/page');
    expect(await outcome(() => SignIn({ searchParams: Promise.resolve({ next: '/t/x' }) }))).toBe('rendered');
    cookie = cookieFor(player);
    expect(await outcome(() => SignIn({ searchParams: Promise.resolve({ next: '/t/x' }) }))).toBe('REDIRECT:/t/x');
    expect(await outcome(() => SignIn({ searchParams: Promise.resolve({ next: 'https://evil.example' }) }))).toBe('REDIRECT:/me');
    expect(await outcome(() => SignIn({ searchParams: Promise.resolve({ next: '//evil.example' }) }))).toBe('REDIRECT:/me');
  });
});
