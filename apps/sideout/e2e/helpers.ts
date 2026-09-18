import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { buildSeed, defaultSeedAnchor, SEED_ORGANIZER_PHONE, SEED_SLUGS } from '../src/db/seed';

/**
 * Seeded identities and the screens the specs walk. The seed mints its ids from a fixed
 * clock and rng (`src/db/seed/build.ts`), so building the dataset here names the same
 * users the database holds; teams and matches are read back through the public API.
 */
export type Envelope<T> = { data: T } | { error: { code: string; message: string } };

const dataset = buildSeed({ anchor: defaultSeedAnchor() });
const organizer = dataset.users.find((u) => u.phoneE164 === SEED_ORGANIZER_PHONE);
if (organizer === undefined) throw new Error('the seed has no organizer');
export const ORGANIZER_ID = organizer.id;
export const SLUGS = SEED_SLUGS;

export type Member = { userId: string; displayName: string; role: 'captain' | 'player' };
export type Team = { id: string; name: string; status: string; members: Member[] };
export type MatchRow = { id: string; round: number; bracketPosition: number | null; poolId: string | null; teamAId: string | null; teamBId: string | null; status: string; bestOf: number };
export type TournamentDetail = {
  id: string;
  slug: string;
  name: string;
  status: string;
  teams: Team[];
  pools: Array<{ id: string; label: string; matches: MatchRow[] }>;
  bracket: { rounds: number; matches: MatchRow[] } | null;
};
export type MatchDetail = {
  match: MatchRow & { sets: unknown[] };
  teamA: Team | null;
  teamB: Team | null;
  consensus: { state: string; live: Array<{ teamId: string }> } | null;
  viewerSide: 'a' | 'b' | null;
};

export async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  const body = (await response.json()) as Envelope<T>;
  if ('error' in body) throw new Error(`${path}: ${body.error.message}`);
  return body.data;
}

export const detail = (request: APIRequestContext, slug: string): Promise<TournamentDetail> => getJson<TournamentDetail>(request, `/api/tournaments/${slug}`);
export const matchDetail = (request: APIRequestContext, id: string): Promise<MatchDetail> => getJson<MatchDetail>(request, `/api/matches/${id}`);

/** Every match of the event, pools first. */
export function allMatches(t: TournamentDetail): MatchRow[] {
  return [...t.pools.flatMap((p) => p.matches), ...(t.bracket?.matches ?? [])];
}

export function teamOf(t: TournamentDetail, id: string | null): Team {
  const team = t.teams.find((x) => x.id === id);
  if (team === undefined) throw new Error(`no team ${id ?? 'null'} in ${t.slug}`);
  return team;
}

export function captainOf(team: Team): Member {
  const captain = team.members.find((m) => m.role === 'captain') ?? team.members[0];
  if (captain === undefined) throw new Error(`team ${team.name} has no members`);
  return captain;
}

/** The page has rendered: a main landmark, no skeleton left in it, and nothing still reading from Purse (`aria-busy`). */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('main .so-skeleton')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

export type Screen = { name: string; path: string; as: 'anonymous' | 'player' | 'organizer'; player?: string };

/**
 * Every screen of spec 5.3 on the seeded data. The player screens sign in as the captain
 * of the upcoming event's first registered team (a team with a place, so the register
 * screen shows its Purse step) or, on the live match, as the team that still has to
 * confirm the opponent's reading.
 */
export async function screens(request: APIRequestContext): Promise<{ list: Screen[]; live: TournamentDetail; upcoming: TournamentDetail; settled: TournamentDetail }> {
  const [live, upcoming, done] = await Promise.all([detail(request, SLUGS.live), detail(request, SLUGS.upcoming), detail(request, SLUGS.settled)]);
  const bracket = live.bracket?.matches ?? [];
  const byStatus = (status: string): MatchRow => {
    const match = bracket.find((m) => m.status === status);
    if (match === undefined) throw new Error(`the live seed has no ${status} bracket match`);
    return match;
  };
  const awaiting = byStatus('awaiting_scores');
  const awaitingView = await matchDetail(request, awaiting.id);
  const submitted = awaitingView.consensus?.live[0]?.teamId ?? null;
  const confirming = teamOf(live, awaiting.teamAId === submitted ? awaiting.teamBId : awaiting.teamAId);
  const registered = upcoming.teams.find((t) => t.status === 'registered') ?? upcoming.teams[0];
  if (registered === undefined) throw new Error('the upcoming seed has no team');
  const player = captainOf(registered).userId;
  const list: Screen[] = [
    { name: 'home', path: '/', as: 'anonymous' },
    { name: 'events', path: '/events', as: 'anonymous' },
    { name: 'impact', path: '/impact', as: 'anonymous' },
    { name: 'sign-in', path: '/sign-in', as: 'anonymous' },
    { name: 'offline', path: '/offline', as: 'anonymous' },
    { name: 'not-found', path: '/t/no-such-event', as: 'anonymous' },
    { name: 'overview', path: `/t/${SLUGS.live}`, as: 'anonymous' },
    { name: 'bracket', path: `/t/${SLUGS.live}/bracket`, as: 'anonymous' },
    { name: 'standings', path: `/t/${SLUGS.live}/standings`, as: 'anonymous' },
    { name: 'tournament-impact', path: `/t/${SLUGS.live}/impact`, as: 'anonymous' },
    { name: 'overview-upcoming', path: `/t/${SLUGS.upcoming}`, as: 'anonymous' },
    { name: 'overview-settled', path: `/t/${SLUGS.settled}`, as: 'anonymous' },
    { name: 'match-final', path: `/m/${byStatus('final').id}`, as: 'anonymous' },
    { name: 'match-disputed', path: `/m/${byStatus('disputed').id}`, as: 'anonymous' },
    { name: 'match-awaiting', path: `/m/${awaiting.id}`, as: 'player', player: captainOf(confirming).userId },
    { name: 'me', path: '/me', as: 'player', player },
    { name: 'teams-new', path: `/teams/new?t=${SLUGS.upcoming}`, as: 'player', player },
    { name: 'register', path: `/t/${SLUGS.upcoming}/register`, as: 'player', player },
    { name: 'console-events', path: '/organizer/events', as: 'organizer' },
    { name: 'console-new-event', path: '/organizer/events/new', as: 'organizer' },
    { name: 'console-builder', path: `/organizer/events/${upcoming.id}`, as: 'organizer' },
    { name: 'console-builder-live', path: `/organizer/events/${live.id}`, as: 'organizer' },
    { name: 'console-board', path: `/organizer/events/${live.id}/board`, as: 'organizer' },
    { name: 'console-close', path: `/organizer/events/${live.id}/close`, as: 'organizer' },
    { name: 'console-close-settled', path: `/organizer/events/${done.id}/close`, as: 'organizer' },
    { name: 'console-disputes', path: '/organizer/disputes', as: 'organizer' },
    { name: 'admin-purse', path: '/admin/purse', as: 'organizer' },
  ];
  return { list, live, upcoming, settled: done };
}

export function userFor(screen: Screen): string | null {
  if (screen.as === 'organizer') return ORGANIZER_ID;
  if (screen.as === 'player') return screen.player ?? null;
  return null;
}
