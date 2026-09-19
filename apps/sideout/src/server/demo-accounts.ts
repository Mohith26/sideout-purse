import { and, asc, eq } from 'drizzle-orm';
import { VERIFICATION_STATES, type VerificationState } from '@purse/types';

import { matches, teamMembers, teams, tournaments, users, type User } from '../db/schema';
import { buildSeed, defaultSeedAnchor } from '../db/seed';
import { DEMO_ACCOUNT_KEYS, demoRoster, type DemoAccountKey, type DemoRoster } from '../db/seed/demo';
import type { DemoAccount } from '../lib/demo-accounts';
import { bracketRoundLabel } from '../lib/rounds';
import { consensusView } from './consensus';
import type { DbOrTx } from './db';
import { holdsPlace, type ReservationClock } from './field';
import { centsToJson } from './money';
import { bracketRoundCount, countDisputedMatches, listMatchViews } from './screens';

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`): the curated
 * seeded users named by `src/db/seed/demo.ts`, resolved by their seeded phone numbers
 * against the live rows, each with the state a visitor should know before choosing (the
 * match the two captains are on and whether their own scoreline is in, the registrant's
 * team and whether it holds a place, the organizer's dispute queue, what Sideout last heard
 * from Purse about the two Purse-state players). Only read while the switch is on;
 * `POST /api/auth/demo` signs in from the same list (`server/auth/demo.ts`). Reads the
 * database only: nothing here calls Purse, so the sign-in page never waits on it. The
 * shapes are `lib/demo-accounts.ts`, which the picker component shares.
 */

export type { DemoAccount, DemoAccountDetail } from '../lib/demo-accounts';

let cachedRoster: DemoRoster | undefined;

/** The roster is a pure function of the seed builder; derive it once per process. */
export function roster(): DemoRoster {
  if (cachedRoster === undefined) {
    const anchor = defaultSeedAnchor();
    cachedRoster = demoRoster(buildSeed({ anchor }), anchor);
  }
  return cachedRoster;
}

async function userByPhone(db: DbOrTx, phone: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.phoneE164, phone)).limit(1);
  return user ?? null;
}

function verificationStateOf(user: User): VerificationState | null {
  const state = user.purseVerificationState;
  return state !== null && (VERIFICATION_STATES as readonly string[]).includes(state) ? (state as VerificationState) : null;
}

/**
 * Every demo account that resolves, in picker order. An account whose seeded rows are not
 * there (an unseeded database, or a demo that withdrew the team) is left out rather than
 * shown broken; an empty list means nothing of the seed is there.
 */
export async function listDemoAccounts(db: DbOrTx, clock: ReservationClock): Promise<DemoAccount[]> {
  const r = roster();
  const [live] = await db.select({ id: tournaments.id, slug: tournaments.slug, name: tournaments.name }).from(tournaments).where(eq(tournaments.slug, r.liveSlug)).limit(1);
  const [open] = await db.select({ id: tournaments.id, slug: tournaments.slug, name: tournaments.name }).from(tournaments).where(eq(tournaments.slug, r.registrantSlug)).limit(1);
  if (live === undefined || open === undefined) return [];
  const [match] = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, r.matchBracketPosition)))
    .limit(1);
  const out: DemoAccount[] = [];

  const teamAId = match?.teamAId ?? null;
  const teamBId = match?.teamBId ?? null;
  if (match !== undefined && teamAId !== null && teamBId !== null) {
    const [views, consensus] = await Promise.all([listMatchViews(db, live.id), consensusView(db, match.id)]);
    const round = bracketRoundLabel(match.round, bracketRoundCount(views)).replace(/s$/, '');
    const teamName = async (id: string): Promise<string | null> => (await db.select({ name: teams.name }).from(teams).where(eq(teams.id, id)).limit(1))[0]?.name ?? null;
    const scorelineIn = (teamId: string): boolean => consensus?.live.some((s) => s.teamId === teamId) ?? false;
    for (const [key, ownTeamId, opponentId] of [
      ['captain_a', teamAId, teamBId],
      ['captain_b', teamBId, teamAId],
    ] as const) {
      const user = await userByPhone(db, r.phones[key]);
      if (user === null) continue;
      out.push({
        key,
        userId: user.id,
        displayName: user.displayName,
        role: user.role,
        tournament: { slug: live.slug, name: live.name },
        href: `/m/${match.id}`,
        detail: {
          kind: 'match',
          matchId: match.id,
          matchStatus: match.status,
          round,
          teamName: (await teamName(ownTeamId)) ?? 'Team',
          opponentName: await teamName(opponentId),
          ownScorelineIn: scorelineIn(ownTeamId),
          opponentScorelineIn: scorelineIn(opponentId),
        },
      });
    }
  }

  const registrant = await userByPhone(db, r.phones.registrant);
  if (registrant !== null) {
    const [team] = await db
      .select({ id: teams.id, name: teams.name, status: teams.status, holdsPlace: holdsPlace(clock), entryDonationCents: tournaments.entryDonationCents })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
      .where(and(eq(teamMembers.userId, registrant.id), eq(teamMembers.role, 'captain'), eq(teams.tournamentId, open.id)))
      .orderBy(asc(teams.createdAt))
      .limit(1);
    if (team !== undefined) {
      out.push({
        key: 'registrant',
        userId: registrant.id,
        displayName: registrant.displayName,
        role: registrant.role,
        tournament: { slug: open.slug, name: open.name },
        href: `/t/${open.slug}/register`,
        detail: { kind: 'register', teamId: team.id, teamName: team.name, teamStatus: team.status, holdsPlace: team.holdsPlace, entryDonationCents: centsToJson(team.entryDonationCents) },
      });
    }
  }

  const organizer = await userByPhone(db, r.phones.organizer);
  if (organizer !== null && organizer.role === 'organizer') {
    out.push({
      key: 'organizer',
      userId: organizer.id,
      displayName: organizer.displayName,
      role: organizer.role,
      tournament: { slug: live.slug, name: live.name },
      href: '/organizer/events',
      detail: { kind: 'organizer', disputes: await countDisputedMatches(db) },
    });
  }

  for (const key of ['refused', 'verifying'] as const) {
    const user = await userByPhone(db, r.phones[key]);
    if (user === null) continue;
    out.push({
      key,
      userId: user.id,
      displayName: user.displayName,
      role: user.role,
      tournament: { slug: live.slug, name: live.name },
      href: '/me',
      detail: { kind: 'purse', linked: user.purseUserId !== null, verificationState: verificationStateOf(user) },
    });
  }

  const order = new Map(DEMO_ACCOUNT_KEYS.map((key, index) => [key, index]));
  return out.sort((x, y) => (order.get(x.key) ?? 0) - (order.get(y.key) ?? 0));
}

/** One demo account by key, or null when the roster does not resolve to it on this database. */
export async function findDemoAccount(db: DbOrTx, clock: ReservationClock, key: DemoAccountKey): Promise<DemoAccount | null> {
  return (await listDemoAccounts(db, clock)).find((account) => account.key === key) ?? null;
}
