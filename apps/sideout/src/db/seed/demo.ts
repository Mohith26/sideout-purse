import { SEED_ORGANIZER_PHONE, SEED_SLUGS, type SeedDataset } from './build';

/**
 * The public demo's curated accounts (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`), named
 * from the seed dataset by seeded phone number rather than by row id: a phone is the same
 * on every host and survives whatever a demo does to the rows, and the nightly reset
 * (`scripts/demo-reset.ts`) writes the same numbers back. The server
 * (`src/server/demo-accounts.ts`) resolves each phone against the live rows and reads the
 * account's state from there, so a card says what that player can do right now.
 *
 * Six stories, one per card:
 *   captain_a   captain of team A in the Sandbar Classic quarterfinal that is awaiting scores;
 *               their scoreline is in and the match waits on the other side
 *   captain_b   captain of team B in the same match: answers that scoreline (agree, or dispute)
 *   registrant  captain of the complete Pier 9 Open pair that has not entered (its payment
 *               failed): walks the entry donation and the Purse contest entry
 *   organizer   the seeded organizer: the console, the dispute queue and the close
 *   refused     a player Purse refuses: a rejected identity check and a date of birth under
 *               the minimum age, both set by the seed's Purse walk (`purse.ts`)
 *   verifying   a player linked to Purse who has not verified yet: the profile's identity
 *               row opens the Purse identity flow
 *
 * `test/seed.test.ts` proves the roster against the dataset. Pure: no database, no clock.
 */

export const DEMO_ACCOUNT_KEYS = ['captain_a', 'captain_b', 'registrant', 'organizer', 'refused', 'verifying'] as const;
export type DemoAccountKey = (typeof DEMO_ACCOUNT_KEYS)[number];

/** The seeded Sandbar Classic bracket match the two captains play: quarterfinal 4, `awaiting_scores` (`build.ts`, the live event's plan). */
export const DEMO_MATCH_BRACKET_POSITION = 12;

/** How old Purse is told the refused player is: under every minimum age the seeded ruleset names. */
export const DEMO_REFUSED_AGE_YEARS = 16;

export type DemoRoster = {
  /** Seeded phone (E.164) per account. */
  phones: Record<DemoAccountKey, string>;
  /** The live event the captains and the organizer are about. */
  liveSlug: string;
  /** The open event the registrant's team enters. */
  registrantSlug: string;
  matchBracketPosition: number;
  /** `YYYY-MM-DD`: the refused player's date of birth as the seed hands it to Purse, `DEMO_REFUSED_AGE_YEARS` before the anchor. */
  refusedDateOfBirth: string;
};

function phoneOf(data: SeedDataset, userId: string | undefined, what: string): string {
  const user = data.users.find((u) => u.id === userId);
  if (user?.phoneE164 === undefined || user.phoneE164 === null) throw new Error(`seed: the demo ${what} has no phone`);
  return user.phoneE164;
}

/** The date `years` before `anchor`, as `YYYY-MM-DD` (UTC). */
export function dateOfBirthYearsBefore(anchor: Date, years: number): string {
  const date = new Date(Date.UTC(anchor.getUTCFullYear() - years, anchor.getUTCMonth(), anchor.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

/** Derive the roster from a built dataset (the seed builder is deterministic, so this is the same on every host). */
export function demoRoster(data: SeedDataset, anchor: Date): DemoRoster {
  const live = data.tournaments.find((t) => t.slug === SEED_SLUGS.live);
  const upcoming = data.tournaments.find((t) => t.slug === SEED_SLUGS.upcoming);
  const communityCup = data.tournaments.find((t) => t.slug === SEED_SLUGS.communityCup);
  if (live === undefined || upcoming === undefined || communityCup === undefined) throw new Error('seed: the demo events are missing');

  const match = data.matches.find((m) => m.tournamentId === live.id && m.bracketPosition === DEMO_MATCH_BRACKET_POSITION);
  if (match?.teamAId === undefined || match.teamAId === null || match.teamBId === undefined || match.teamBId === null) {
    throw new Error(`seed: the demo match at bracket position ${DEMO_MATCH_BRACKET_POSITION} is not a two-team match`);
  }
  const membersOf = (teamId: string) => data.teamMembers.filter((m) => m.teamId === teamId);
  const captainOf = (teamId: string) => membersOf(teamId).find((m) => m.role === 'captain')?.userId;

  // The complete pair that has not entered Pier 9: forming, two members (the other forming team is a captain waiting on a partner).
  const registrantTeam = data.teams.find((t) => t.tournamentId === upcoming.id && t.status === 'forming' && membersOf(t.id).length === 2);
  if (registrantTeam === undefined) throw new Error('seed: the demo registrant team is missing');

  // The Pier 9 captain whose checkout never finished: the team holds no place until they register again.
  const lapsedDonation = data.donations.find((d) => d.tournamentId === upcoming.id && d.teamId !== null && d.status === 'pending');
  if (lapsedDonation?.teamId === undefined || lapsedDonation.teamId === null) throw new Error('seed: the demo refused player (the lapsed Pier 9 checkout) is missing');

  // The Community Cup captain still waiting on a partner: one member, an invite out.
  const waitingTeam = data.teams.find((t) => t.tournamentId === communityCup.id && t.status === 'forming' && membersOf(t.id).length === 1);
  if (waitingTeam === undefined) throw new Error('seed: the demo verifying player (the waiting Community Cup captain) is missing');

  const organizer = data.users.find((u) => u.phoneE164 === SEED_ORGANIZER_PHONE && u.role === 'organizer');

  return {
    phones: {
      captain_a: phoneOf(data, captainOf(match.teamAId), 'captain A'),
      captain_b: phoneOf(data, captainOf(match.teamBId), 'captain B'),
      registrant: phoneOf(data, captainOf(registrantTeam.id), 'registrant'),
      organizer: phoneOf(data, organizer?.id, 'organizer'),
      refused: phoneOf(data, captainOf(lapsedDonation.teamId), 'refused player'),
      verifying: phoneOf(data, captainOf(waitingTeam.id), 'verifying player'),
    },
    liveSlug: SEED_SLUGS.live,
    registrantSlug: SEED_SLUGS.upcoming,
    matchBracketPosition: DEMO_MATCH_BRACKET_POSITION,
    refusedDateOfBirth: dateOfBirthYearsBefore(anchor, DEMO_REFUSED_AGE_YEARS),
  };
}
