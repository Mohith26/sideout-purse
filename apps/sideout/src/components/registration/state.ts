import type { DonationStatus, TeamStatus, TournamentStatus } from '../../db/schema';

/**
 * Where a team is in registration (spec 5.3, "Register"), derived from rows so the page,
 * the tests and the e2e flow agree. Two steps: the charitable donation (step 1) and the
 * Purse contest entry (step 2), never confused with each other.
 */
export type RegistrationInput = {
  tournamentStatus: TournamentStatus;
  /** Null when the viewer has no live team in the event. */
  team: { status: TeamStatus; memberCount: number; invitedPhone: string | null; holdsPlace: boolean; isCaptain: boolean } | null;
  donation: { id: string; status: DonationStatus; amountCents: string; currency: string; lastPaymentError: string | null; reservationExpiresAt: string | null } | null;
  /** The event's entry donation; "0" means entry is free and step 1 records nothing. */
  entryDonationCents: string;
  /** Event capacity already reached by other teams. */
  full: boolean;
};

export type RegistrationState =
  | { kind: 'no_team' }
  | { kind: 'closed'; tournamentStatus: TournamentStatus }
  | { kind: 'waiting_partner'; invitedPhone: string | null }
  | { kind: 'ready'; full: boolean; isCaptain: boolean }
  /** A registered team whose reservation lapsed without a payment: the captain may register again. */
  | { kind: 'lapsed'; isCaptain: boolean; donation: RegistrationInput['donation'] }
  | { kind: 'registered'; donation: RegistrationInput['donation']; entriesOpen: boolean };

export function registrationState(input: RegistrationInput): RegistrationState {
  const { team } = input;
  const open = input.tournamentStatus === 'registration_open';
  if (team === null || team.status === 'withdrawn') return open ? { kind: 'no_team' } : { kind: 'closed', tournamentStatus: input.tournamentStatus };
  if (team.status === 'registered' || team.status === 'checked_in') {
    if (!team.holdsPlace && open) return { kind: 'lapsed', isCaptain: team.isCaptain, donation: input.donation };
    return { kind: 'registered', donation: input.donation, entriesOpen: open || input.tournamentStatus === 'registration_closed' };
  }
  if (!open) return { kind: 'closed', tournamentStatus: input.tournamentStatus };
  if (team.memberCount < 2) return { kind: 'waiting_partner', invitedPhone: team.invitedPhone };
  return { kind: 'ready', full: input.full, isCaptain: team.isCaptain };
}

/** Step 1's visual state: what the donation card says. */
export type DonationStepState = 'locked' | 'due' | 'processing' | 'received' | 'failed' | 'free' | 'refunded';

export function donationStep(state: RegistrationState, entryDonationCents: string): DonationStepState {
  const free = BigInt(entryDonationCents) === 0n;
  if (state.kind === 'ready' || state.kind === 'lapsed') return free ? 'free' : 'due';
  if (state.kind === 'registered') {
    if (state.donation === null) return free ? 'free' : 'locked';
    switch (state.donation.status) {
      case 'pending':
        return 'processing';
      case 'succeeded':
        return 'received';
      case 'failed':
        return 'failed';
      case 'refunded':
        return 'refunded';
    }
  }
  return 'locked';
}
