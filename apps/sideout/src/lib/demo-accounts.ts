import type { VerificationState } from '@purse/types';

import type { MatchStatus, TeamStatus, User } from '../db/schema';
import type { DemoAccountKey } from '../db/seed/demo';

/**
 * The public demo's account picker as it crosses the wire and reaches the client
 * component (`docs/demo-accounts.md`): one of the curated seeded users
 * (`src/db/seed/demo.ts`) with the state a visitor should know before choosing. Built by
 * `server/demo-accounts.ts` from the rows; cents are decimal strings, like every other
 * envelope (`server/money.ts`). Types only, so the picker (`components/auth/DemoAccounts`)
 * imports nothing of the server.
 */
export type DemoAccountDetail =
  | { kind: 'match'; matchId: string; matchStatus: MatchStatus; round: string; teamName: string; opponentName: string | null; ownScorelineIn: boolean; opponentScorelineIn: boolean }
  | { kind: 'register'; teamId: string; teamName: string; teamStatus: TeamStatus; holdsPlace: boolean; entryDonationCents: string }
  | { kind: 'organizer'; disputes: number }
  | { kind: 'purse'; linked: boolean; verificationState: VerificationState | null };

export type DemoAccount = {
  key: DemoAccountKey;
  userId: string;
  displayName: string;
  role: User['role'];
  /** The event the account's story is about. */
  tournament: { slug: string; name: string };
  /** Where the picker sends the visitor after signing in. */
  href: string;
  detail: DemoAccountDetail;
};
