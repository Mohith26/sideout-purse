import { eq } from 'drizzle-orm';
import { errorFields, type Logger } from '@repo/logger';
import { newId } from '@repo/ids';
import { z } from 'zod';

import type { Db } from '../db/client';
import { donations, teamMembers, teams, tournaments, users, type Donation, type Team, type Tournament, type User } from '../db/schema';
import { describeFailure, isPurseFailure } from '../purse';
import { checkTeamRoster } from '../domain/team';
import { actorFor } from './actor';
import { writeAudit } from './audit';
import { applyDonationStatus, cancelSupersededPayments } from './donations/service';
import { DonationProviderError, type DonationProvider } from './donations/provider';
import { countedTeams, reservationExpiresAt, teamHoldsPlace, type ReservationClock } from './field';
import { failure } from './http/errors';
import { DONATION_CURRENCY } from './money';
import { ensurePurseContest } from './purse/contests';
import type { PurseDeps } from './purse/deps';

/**
 * Tournament registration: a complete two-member team, an open window, capacity, then the
 * charitable donation through the provider. Registering reserves the place; the pending
 * donation holds it for the reservation TTL (`server/field.ts`), after which the captain
 * may register again for a fresh payment, and the payment it replaces is cancelled at the
 * provider. The Purse contest entry, the visually distinct second step of the Register
 * screen (spec 5.3 item 4), is phase 7 and enters through `PurseContestEntry` below.
 */

export const registerTeamSchema = z.object({ teamId: z.string().startsWith('tm_') });

/**
 * The second step of registration (spec 5.3, "Register"): the Purse contest entry, made by
 * each player in the SDK's entry flow, visually apart from the donation so nobody thinks
 * their donation is a stake. The server's part is to make sure the tournament's contest
 * exists and to tell the browser which contest to confirm; the entry itself is the
 * player's act on the Purse origin, and `POST /api/teams/:id/purse/entries` reads it back.
 * With no Purse configured (`purseContestEntryNotWired`, outside production only) the
 * response says so and no entry is claimed.
 */
export type PurseEntryStep =
  | { status: 'ready'; contestId: string; players: Array<{ userId: string; linked: boolean }> }
  | { status: 'unavailable'; reason: string }
  | { status: 'not_wired' };

export type PurseContestEntry = (input: { tournament: Tournament; team: Team; captain: User; requestId: string; now: Date }) => Promise<PurseEntryStep>;

export const purseContestEntryNotWired: PurseContestEntry = async () => {
  await Promise.resolve();
  return { status: 'not_wired' };
};

/** The wired step: the contest is created (idempotently) if the transition that opened registration could not reach Purse. */
export function purseContestEntryWired(deps: PurseDeps): PurseContestEntry {
  return async ({ tournament, team, requestId, now }) => {
    const members = await deps.db
      .select({ userId: users.id, purseUserId: users.purseUserId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, team.id));
    try {
      const contest = await ensurePurseContest(deps, tournament, { requestId, now });
      return { status: 'ready', contestId: contest.id, players: members.map((m) => ({ userId: m.userId, linked: m.purseUserId !== null })) };
    } catch (error) {
      if (!isPurseFailure(error)) throw error;
      const described = describeFailure(error, now);
      deps.log.warn('purse entry step unavailable', { tournamentId: tournament.id, teamId: team.id, ...described });
      return { status: 'unavailable', reason: described.message };
    }
  };
}

export type RegistrationDeps = {
  db: Db;
  /** `null` means no provider is configured (production without Stripe): registration refuses. */
  provider: DonationProvider | null;
  purseEntry: PurseContestEntry;
  log: Logger;
  reservationTtlMs: number;
};

export type RegistrationResult = {
  team: Team;
  donation: Donation | null;
  /** When the place is released if the donation is still pending; null for free entry or a settled payment. */
  reservationExpiresAt: Date | null;
  /** What the browser needs to complete a Stripe payment; null for the dev provider or free entry. */
  clientSecret: string | null;
  purseEntry: PurseEntryStep;
};

export async function registerTeam(
  deps: RegistrationDeps,
  input: { tournamentSlug: string; teamId: string; user: User; requestId: string; now: Date },
): Promise<RegistrationResult> {
  const { db, now, user } = { db: deps.db, now: input.now, user: input.user };
  const clock: ReservationClock = { now, reservationTtlMs: deps.reservationTtlMs };

  // Step 1: validate and reserve the spot, without holding any lock across a network call.
  const reserved = await db.transaction(async (tx) => {
    const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.slug, input.tournamentSlug)).for('update');
    if (tournament === undefined || tournament.status === 'draft') throw failure.notFound('tournament_not_found', 'No such tournament.');
    if (tournament.status !== 'registration_open') {
      throw failure.invalidState('registration_not_open', `Registration for ${tournament.name} is ${tournament.status.replace('_', ' ')}.`);
    }
    if (tournament.startsAt.getTime() <= now.getTime()) {
      throw failure.invalidState('registration_window_closed', `${tournament.name} has already started.`);
    }

    const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId)).for('update');
    if (team?.tournamentId !== tournament.id) throw failure.notFound('team_not_found', 'No such team in this tournament.');
    const members = await tx.select().from(teamMembers).where(eq(teamMembers.teamId, team.id));
    const me = members.find((m) => m.userId === user.id);
    if (me?.role !== 'captain') throw failure.permission('captain_required', 'Only the team captain can register the team.');
    const reservationLapsed = team.status === 'registered' && !(await teamHoldsPlace(tx, team.id, clock));
    if (team.status !== 'forming' && !reservationLapsed) throw failure.invalidState('already_registered', `${team.name} is already ${team.status}.`);
    const roster = checkTeamRoster(members.map((m) => ({ userId: m.userId, role: m.role })));
    if (!roster.ok) throw failure.invalidState('team_incomplete', roster.reason);

    const registered = await countedTeams(tx, tournament.id, clock);
    if (registered >= tournament.maxTeams) {
      throw failure.invalidState('tournament_full', `${tournament.name} is full (${tournament.maxTeams} teams).`);
    }

    if (tournament.entryDonationCents > 0n && deps.provider === null) {
      throw failure.internal('donation_provider_unavailable', 'Donations cannot be taken right now.').withStatus(503);
    }

    const [updatedTeam] = await tx
      .update(teams)
      .set({ status: 'registered', registeredAt: now, updatedAt: now })
      .where(eq(teams.id, team.id))
      .returning();
    if (updatedTeam === undefined) throw new Error('team update returned no row');

    let donation: Donation | null = null;
    if (tournament.entryDonationCents > 0n && deps.provider !== null) {
      const donationId = newId('don');
      const [inserted] = await tx
        .insert(donations)
        .values({
          id: donationId,
          tournamentId: tournament.id,
          teamId: team.id,
          userId: user.id,
          amountCents: tournament.entryDonationCents,
          currency: DONATION_CURRENCY,
          provider: deps.provider.name,
          // Replaced by the provider's reference in step 2; unique per donation meanwhile.
          providerRef: `pending:${donationId}`,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (inserted === undefined) throw new Error('donation insert returned no row');
      donation = inserted;
      await writeAudit(tx, {
        actor: actorFor(user),
        action: 'donation.created',
        subjectType: 'donation',
        subjectId: donation.id,
        detail: { tournamentId: tournament.id, teamId: team.id, amountCents: donation.amountCents.toString(), currency: donation.currency, provider: donation.provider },
        at: now,
      });
    }
    await writeAudit(tx, {
      actor: actorFor(user),
      action: reservationLapsed ? 'team.reservation_renewed' : 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: team.status, to: 'registered', reason: 'registration', donationId: donation?.id ?? null, purseEntry: 'second_step' },
      at: now,
    });
    return { tournament, team: updatedTeam, donation };
  });

  // Step 2: take the payment. A provider failure marks the donation failed, which releases the spot.
  let clientSecret: string | null = null;
  let donation = reserved.donation;
  if (donation !== null && deps.provider !== null) {
    const provider = deps.provider;
    const donationId = donation.id;
    try {
      const payment = await provider.createPayment(
        {
          donationId,
          amountCents: donation.amountCents,
          currency: donation.currency,
          description: `Sideout entry donation: ${reserved.tournament.name}`,
          metadata: { donation_id: donationId, tournament_id: reserved.tournament.id, team_id: reserved.team.id },
        },
        { requestId: input.requestId },
      );
      clientSecret = payment.clientSecret;
      donation = await db.transaction(async (tx) => {
        const [withRef] = await tx.update(donations).set({ providerRef: payment.providerRef, updatedAt: now }).where(eq(donations.id, donationId)).returning();
        if (withRef === undefined) throw new Error('donation update returned no row');
        if (payment.status === 'succeeded') {
          const result = await applyDonationStatus(tx, { donationId, status: 'succeeded', clock });
          await writeAudit(tx, {
            actor: actorFor(user),
            action: 'donation.succeeded',
            subjectType: 'donation',
            subjectId: donationId,
            detail: { provider: provider.name, providerRef: payment.providerRef },
            at: now,
          });
          return result.donation;
        }
        return withRef;
      });
    } catch (error) {
      deps.log.error('donation provider failed', { donationId, ...errorFields(error) });
      await db.transaction(async (tx) => {
        const failed = await applyDonationStatus(tx, { donationId, status: 'failed', clock });
        await writeAudit(tx, {
          actor: actorFor(user),
          action: 'donation.failed',
          subjectType: 'donation',
          subjectId: failed.donation.id,
          detail: { reason: error instanceof DonationProviderError ? 'provider_error' : 'unexpected_error' },
          at: now,
        });
      });
      throw failure.internal('donation_provider_error', 'The donation could not be started; nothing was charged.').withStatus(502);
    }
    await cancelSupersededPayments({ db, provider, log: deps.log }, { donationId, requestId: input.requestId });
  }

  const [team] = await db.select().from(teams).where(eq(teams.id, reserved.team.id));
  const captain = user;
  const purseEntry = await deps.purseEntry({ tournament: reserved.tournament, team: team ?? reserved.team, captain, requestId: input.requestId, now });
  const expiresAt = donation?.status === 'pending' ? reservationExpiresAt(donation, clock) : null;
  return { team: team ?? reserved.team, donation, reservationExpiresAt: expiresAt, clientSecret, purseEntry };
}
