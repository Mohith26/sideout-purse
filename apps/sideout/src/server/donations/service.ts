import { and, count, desc, eq, inArray, ne, sql, sum } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../../db/client';
import { donationProviderEvents, donations, teams, tournaments, users, type Donation, type DonationStatus } from '../../db/schema';
import { SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { DbOrTx } from '../db';
import { countedTeams, type ReservationClock } from '../field';
import { interpretStripeEvent, type StripeEvent } from './stripe';

/**
 * Donation lifecycle and the figures derived from it. Nothing in this module knows about
 * Purse, contests, points or credit; the impact figures it computes are sums over
 * `donations` rows and nothing else (spec acceptance criterion 21).
 */

/**
 * pending → succeeded | failed; failed → succeeded (a retried payment on the same
 * intent); succeeded → refunded. Anything else is ignored, which is what keeps an
 * out-of-order or redelivered provider event from corrupting a donation.
 */
export const DONATION_TRANSITIONS: Readonly<Record<DonationStatus, readonly DonationStatus[]>> = {
  pending: ['succeeded', 'failed'],
  failed: ['succeeded'],
  succeeded: ['refunded'],
  refunded: [],
};

/** What applying a donation status did to the team's registration. */
export type RegistrationEffect = 'unchanged' | 'confirmed' | 'released' | 'withdrawn' | 'withdrawn_tournament_full';

export type ApplyStatusResult = { changed: boolean; donation: Donation; previous: DonationStatus; registration: RegistrationEffect };

/**
 * Move a donation to `status` if the transition is legal, record any refunded amount, and
 * keep its team's registration in step: a succeeded entry donation confirms the team (or
 * withdraws it, refund due, when its reservation lapsed and the place went to someone
 * else), a failed one with no other live payment releases the spot, a full refund
 * withdraws the team. `refundedCents` is a running total, so an older event never lowers it.
 */
export async function applyDonationStatus(
  tx: DbOrTx,
  input: { donationId: string; status: DonationStatus; refundedCents?: bigint | undefined; clock: ReservationClock },
): Promise<ApplyStatusResult> {
  const [donation] = await tx.select().from(donations).where(eq(donations.id, input.donationId)).for('update');
  if (donation === undefined) throw new Error(`donation ${input.donationId} not found`);
  const previous = donation.status;
  const now = input.clock.now;

  const nextStatus = previous !== input.status && DONATION_TRANSITIONS[previous].includes(input.status) ? input.status : previous;
  const nextRefunded =
    input.refundedCents === undefined ? donation.refundedCents : input.refundedCents > donation.refundedCents ? input.refundedCents : donation.refundedCents;
  if (nextStatus === previous && nextRefunded === donation.refundedCents) {
    return { changed: false, donation, previous, registration: 'unchanged' };
  }
  const [updated] = await tx
    .update(donations)
    .set({ status: nextStatus, refundedCents: nextRefunded, updatedAt: now })
    .where(eq(donations.id, donation.id))
    .returning();
  if (updated === undefined) throw new Error('donation update returned no row');

  const registration =
    donation.teamId === null || nextStatus === previous ? 'unchanged' : await syncTeamRegistration(tx, { teamId: donation.teamId, donation: updated, clock: input.clock });
  return { changed: true, donation: updated, previous, registration };
}

async function syncTeamRegistration(tx: DbOrTx, input: { teamId: string; donation: Donation; clock: ReservationClock }): Promise<RegistrationEffect> {
  const now = input.clock.now;
  const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId)).for('update');
  if (team === undefined) return 'unchanged';

  if (input.donation.status === 'succeeded' && (team.status === 'forming' || team.status === 'registered')) {
    const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.id, team.tournamentId)).for('update');
    if (tournament === undefined) throw new Error(`tournament ${team.tournamentId} not found`);
    const others = await countedTeams(tx, tournament.id, input.clock, { excluding: team.id });
    if (others >= tournament.maxTeams) {
      await tx.update(teams).set({ status: 'withdrawn', updatedAt: now }).where(eq(teams.id, team.id));
      await writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'team.status_changed',
        subjectType: 'team',
        subjectId: team.id,
        detail: { from: team.status, to: 'withdrawn', reason: 'tournament_full', donationId: input.donation.id },
        at: now,
      });
      await writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'donation.refund_due',
        subjectType: 'donation',
        subjectId: input.donation.id,
        detail: {
          reason: 'tournament_full',
          tournamentId: tournament.id,
          teamId: team.id,
          amountCents: input.donation.amountCents.toString(),
          currency: input.donation.currency,
          provider: input.donation.provider,
          providerRef: input.donation.providerRef,
        },
        at: now,
      });
      return 'withdrawn_tournament_full';
    }
    if (team.status === 'registered') return 'confirmed';
    await tx.update(teams).set({ status: 'registered', registeredAt: team.registeredAt ?? now, updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: 'forming', to: 'registered', reason: 'donation_succeeded', donationId: input.donation.id },
      at: now,
    });
    return 'confirmed';
  }

  if (input.donation.status === 'failed' && team.status === 'registered') {
    const [live] = await tx
      .select({ n: count() })
      .from(donations)
      .where(and(eq(donations.teamId, team.id), ne(donations.id, input.donation.id), inArray(donations.status, ['pending', 'succeeded'])));
    if ((live?.n ?? 0) > 0) return 'unchanged';
    await tx.update(teams).set({ status: 'forming', registeredAt: null, updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: 'registered', to: 'forming', reason: 'donation_failed', donationId: input.donation.id },
      at: now,
    });
    return 'released';
  }

  if (input.donation.status === 'refunded' && (team.status === 'registered' || team.status === 'checked_in')) {
    await tx.update(teams).set({ status: 'withdrawn', updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: team.status, to: 'withdrawn', reason: 'donation_refunded', donationId: input.donation.id },
      at: now,
    });
    return 'withdrawn';
  }
  return 'unchanged';
}

export type WebhookOutcome =
  | { duplicate: true }
  | { duplicate: false; applied: false; reason: 'ignored_event_type' | 'unknown_payment_intent' | 'no_transition' }
  | { duplicate: false; applied: true; donationId: string; from: DonationStatus; to: DonationStatus; refundedCents: string; registration: RegistrationEffect };

/**
 * Apply one verified Stripe event, idempotently on `event.id`: the event row is inserted
 * first (a conflict means it was already processed) and the donation change rides the
 * same transaction, so a crash between the two leaves nothing half-applied. The outcome
 * names what happened to the team, so a late payment that found the event full is
 * visible to whoever confirmed it rather than a silent 200.
 */
export async function applyStripeEvent(db: Db, event: StripeEvent, clock: ReservationClock): Promise<WebhookOutcome> {
  const now = clock.now;
  return db.transaction(async (tx) => {
    const [recorded] = await tx
      .insert(donationProviderEvents)
      .values({ id: newId('dpe'), provider: 'stripe', eventId: event.id, eventType: event.type, receivedAt: now })
      .onConflictDoNothing({ target: [donationProviderEvents.provider, donationProviderEvents.eventId] })
      .returning({ id: donationProviderEvents.id });
    if (recorded === undefined) return { duplicate: true };

    const interpreted = interpretStripeEvent(event);
    if (interpreted === null) return { duplicate: false, applied: false, reason: 'ignored_event_type' };

    const [donation] = await tx
      .select({ id: donations.id })
      .from(donations)
      .where(and(eq(donations.provider, 'stripe'), eq(donations.providerRef, interpreted.paymentIntentId)));
    if (donation === undefined) return { duplicate: false, applied: false, reason: 'unknown_payment_intent' };

    await tx.update(donationProviderEvents).set({ donationId: donation.id }).where(eq(donationProviderEvents.id, recorded.id));
    const result = await applyDonationStatus(tx, { donationId: donation.id, status: interpreted.status, refundedCents: interpreted.refundedCents, clock });
    if (!result.changed) return { duplicate: false, applied: false, reason: 'no_transition' };

    const to = result.donation.status;
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: to === result.previous ? 'donation.refund_recorded' : `donation.${to}`,
      subjectType: 'donation',
      subjectId: donation.id,
      detail: {
        provider: 'stripe',
        eventId: event.id,
        eventType: event.type,
        from: result.previous,
        refundedCents: result.donation.refundedCents.toString(),
        registration: result.registration,
      },
      at: now,
    });
    return {
      duplicate: false,
      applied: true,
      donationId: donation.id,
      from: result.previous,
      to,
      refundedCents: result.donation.refundedCents.toString(),
      registration: result.registration,
    };
  });
}

// ---- Derived figures ----------------------------------------------------------------------

export type DonationTotals = { raisedCents: bigint; donationCount: number };

/** What a donation still counts for: its amount less whatever the provider has refunded. */
const netCents = sql<string>`${donations.amountCents} - ${donations.refundedCents}`;

/** Sum of succeeded donations net of partial refunds. Pending, failed and refunded rows contribute nothing. */
export async function donationTotals(db: DbOrTx, tournamentId: string): Promise<DonationTotals> {
  const [row] = await db
    .select({ raised: sum(netCents), n: count() })
    .from(donations)
    .where(and(eq(donations.tournamentId, tournamentId), eq(donations.status, 'succeeded')));
  return { raisedCents: BigInt(row?.raised ?? '0'), donationCount: row?.n ?? 0 };
}

export type Donor = { displayName: string | null; amountCents: bigint; at: Date };

/** The most recent succeeded donations, net of partial refunds, with the donor's name where one is on file. */
export async function recentDonors(db: DbOrTx, tournamentId: string, limit = 20): Promise<Donor[]> {
  const rows = await db
    .select({ displayName: users.displayName, amountCents: netCents, at: donations.updatedAt })
    .from(donations)
    .leftJoin(users, eq(users.id, donations.userId))
    .where(and(eq(donations.tournamentId, tournamentId), eq(donations.status, 'succeeded')))
    .orderBy(desc(donations.updatedAt))
    .limit(limit);
  return rows.map((r) => ({ displayName: r.displayName, amountCents: BigInt(r.amountCents), at: r.at }));
}
