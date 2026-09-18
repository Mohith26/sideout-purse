import { and, count, desc, eq, inArray, ne, sql, sum } from 'drizzle-orm';
import { errorFields, type Logger } from '@repo/logger';
import { newId } from '@repo/ids';

import type { Db } from '../../db/client';
import { donationProviderEvents, donations, teams, tournaments, users, type Donation, type DonationStatus, type Team, type Tournament } from '../../db/schema';
import { SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { DbOrTx } from '../db';
import { countedTeams, type ReservationClock } from '../field';
import type { DonationProvider } from './provider';
import { interpretStripeEvent, type StripeEvent } from './stripe';

/**
 * Donation lifecycle and the figures derived from it. Nothing in this module knows about
 * Purse, contests, points or credit; the impact figures it computes are sums over
 * `donations` rows and nothing else (spec acceptance criterion 21).
 */

/**
 * pending → succeeded | failed | refunded; failed → succeeded (a retried payment on the
 * same intent) | refunded; succeeded → refunded. `refunded` is terminal: a refund proves
 * the charge existed, so a success event that arrives after it (Stripe does not order
 * deliveries) is recorded in the audit log and changes nothing. Anything else is ignored,
 * which is what keeps an out-of-order or redelivered provider event from corrupting a
 * donation.
 */
export const DONATION_TRANSITIONS: Readonly<Record<DonationStatus, readonly DonationStatus[]>> = {
  pending: ['succeeded', 'failed', 'refunded'],
  failed: ['succeeded', 'refunded'],
  succeeded: ['refunded'],
  refunded: [],
};

/** What applying a donation status did to the team's registration. */
export type RegistrationEffect = 'unchanged' | 'confirmed' | 'released' | 'withdrawn';

/**
 * Why a succeeded donation could not buy its team a place, so the organizer knows what to
 * refund: the event filled up while the reservation had lapsed, the field was already
 * fixed (registration closed for good, live, or later), the team had already withdrawn,
 * or another donation already pays for the same entry.
 */
export type RefundDueReason = 'event_full' | 'registration_closed' | 'team_withdrawn' | 'duplicate_payment';

export type ApplyStatusResult = {
  changed: boolean;
  donation: Donation;
  previous: DonationStatus;
  registration: RegistrationEffect;
  refundDue: RefundDueReason | null;
};

/**
 * Move a donation to `status` if the transition is legal, record any refunded amount, and
 * keep its team's registration in step: a succeeded entry donation confirms the team, or
 * leaves it out with a `donation.refund_due` audit row when there is no place for it; a
 * failed one with no other live payment releases the spot; a full refund withdraws the
 * team unless another succeeded donation still pays for it. `refundedCents` is a running
 * total, so an older event never lowers it.
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
    return { changed: false, donation, previous, registration: 'unchanged', refundDue: null };
  }
  const [updated] = await tx
    .update(donations)
    .set({ status: nextStatus, refundedCents: nextRefunded, updatedAt: now })
    .where(eq(donations.id, donation.id))
    .returning();
  if (updated === undefined) throw new Error('donation update returned no row');

  if (donation.teamId === null || nextStatus === previous) return { changed: true, donation: updated, previous, registration: 'unchanged', refundDue: null };
  const effect = await syncTeamRegistration(tx, { teamId: donation.teamId, donation: updated, clock: input.clock });
  return { changed: true, donation: updated, previous, ...effect };
}

type SyncEffect = { registration: RegistrationEffect; refundDue: RefundDueReason | null };

/** Locks the tournament before the team, the same order registration takes them in. */
async function syncTeamRegistration(tx: DbOrTx, input: { teamId: string; donation: Donation; clock: ReservationClock }): Promise<SyncEffect> {
  const now = input.clock.now;
  const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.id, input.donation.tournamentId)).for('update');
  if (tournament === undefined) throw new Error(`tournament ${input.donation.tournamentId} not found`);
  const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId)).for('update');
  if (team === undefined) return { registration: 'unchanged', refundDue: null };

  if (input.donation.status === 'succeeded') {
    if (team.status === 'withdrawn') {
      await refundDue(tx, { tournament, team, donation: input.donation, reason: 'team_withdrawn', now });
      return { registration: 'unchanged', refundDue: 'team_withdrawn' };
    }
    if (await otherPaidDonation(tx, team.id, input.donation.id)) {
      await refundDue(tx, { tournament, team, donation: input.donation, reason: 'duplicate_payment', now });
      return { registration: 'unchanged', refundDue: 'duplicate_payment' };
    }
    const fieldFixed = tournament.status !== 'registration_open' && tournament.status !== 'registration_closed';
    const full = (await countedTeams(tx, tournament.id, input.clock, { excluding: team.id })) >= tournament.maxTeams;
    if (fieldFixed || full) {
      const reason: RefundDueReason = fieldFixed ? 'registration_closed' : 'event_full';
      await tx.update(teams).set({ status: 'withdrawn', updatedAt: now }).where(eq(teams.id, team.id));
      await writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'team.status_changed',
        subjectType: 'team',
        subjectId: team.id,
        detail: { from: team.status, to: 'withdrawn', reason, donationId: input.donation.id },
        at: now,
      });
      await refundDue(tx, { tournament, team, donation: input.donation, reason, now });
      return { registration: 'withdrawn', refundDue: reason };
    }
    if (team.status !== 'forming') return { registration: 'confirmed', refundDue: null };
    await tx.update(teams).set({ status: 'registered', registeredAt: team.registeredAt ?? now, updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: 'forming', to: 'registered', reason: 'donation_succeeded', donationId: input.donation.id },
      at: now,
    });
    return { registration: 'confirmed', refundDue: null };
  }

  if (input.donation.status === 'failed' && team.status === 'registered') {
    const [live] = await tx
      .select({ n: count() })
      .from(donations)
      .where(and(eq(donations.teamId, team.id), ne(donations.id, input.donation.id), inArray(donations.status, ['pending', 'succeeded'])));
    if ((live?.n ?? 0) > 0) return { registration: 'unchanged', refundDue: null };
    await tx.update(teams).set({ status: 'forming', registeredAt: null, updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: 'registered', to: 'forming', reason: 'donation_failed', donationId: input.donation.id },
      at: now,
    });
    return { registration: 'released', refundDue: null };
  }

  if (input.donation.status === 'refunded' && (team.status === 'registered' || team.status === 'checked_in')) {
    if (await otherPaidDonation(tx, team.id, input.donation.id)) return { registration: 'unchanged', refundDue: null };
    await tx.update(teams).set({ status: 'withdrawn', updatedAt: now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: team.status, to: 'withdrawn', reason: 'donation_refunded', donationId: input.donation.id },
      at: now,
    });
    return { registration: 'withdrawn', refundDue: null };
  }
  return { registration: 'unchanged', refundDue: null };
}

async function otherPaidDonation(tx: DbOrTx, teamId: string, donationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: donations.id })
    .from(donations)
    .where(and(eq(donations.teamId, teamId), ne(donations.id, donationId), eq(donations.status, 'succeeded')))
    .limit(1);
  return row !== undefined;
}

/** The money was taken but buys no place: name what the organizer must refund, and why. */
async function refundDue(tx: DbOrTx, input: { tournament: Tournament; team: Team; donation: Donation; reason: RefundDueReason; now: Date }): Promise<void> {
  await writeAudit(tx, {
    actor: SYSTEM_ACTOR,
    action: 'donation.refund_due',
    subjectType: 'donation',
    subjectId: input.donation.id,
    detail: {
      reason: input.reason,
      tournamentId: input.tournament.id,
      tournamentStatus: input.tournament.status,
      teamId: input.team.id,
      teamStatus: input.team.status,
      amountCents: input.donation.amountCents.toString(),
      currency: input.donation.currency,
      provider: input.donation.provider,
      providerRef: input.donation.providerRef,
    },
    at: input.now,
  });
}

export type WebhookOutcome =
  | { duplicate: true }
  | { duplicate: false; applied: false; reason: 'ignored_event_type' | 'unknown_payment_intent' | 'no_transition' | 'already_refunded' }
  | {
      duplicate: false;
      applied: true;
      donationId: string;
      from: DonationStatus;
      to: DonationStatus;
      refundedCents: string;
      registration: RegistrationEffect;
      refundDue: RefundDueReason | null;
    };

/**
 * Apply one verified Stripe event, idempotently on `event.id`: the event row is inserted
 * first (a conflict means it was already processed) and the donation change rides the
 * same transaction, so a crash between the two leaves nothing half-applied. The outcome
 * names what happened to the team and any refund now due, so a late payment that found
 * no place is visible to whoever confirmed it rather than a silent 200.
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
    if (!result.changed) {
      if (interpreted.status !== 'succeeded' || result.donation.status !== 'refunded') return { duplicate: false, applied: false, reason: 'no_transition' };
      await writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'donation.succeeded_after_refund',
        subjectType: 'donation',
        subjectId: donation.id,
        detail: { provider: 'stripe', eventId: event.id, eventType: event.type, refundedCents: result.donation.refundedCents.toString() },
        at: now,
      });
      return { duplicate: false, applied: false, reason: 'already_refunded' };
    }

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
        refundDue: result.refundDue,
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
      refundDue: result.refundDue,
    };
  });
}

/**
 * Once one donation pays for a team's entry, cancel the team's other unfinished payments
 * at the provider so a stale tab or a slow payment method cannot take the money twice.
 * Best effort and outside any transaction: a cancellation the provider refuses (or a
 * network failure) is logged, and the local rows are left for the provider's own events to
 * settle. Returns the ids whose payments were cancelled.
 */
export async function cancelSupersededPayments(
  deps: { db: Db; provider: DonationProvider; log: Logger },
  input: { donationId: string; requestId: string },
): Promise<string[]> {
  const [current] = await deps.db.select().from(donations).where(eq(donations.id, input.donationId));
  if (current?.teamId === null || current?.teamId === undefined) return [];
  const superseded = await deps.db
    .select()
    .from(donations)
    .where(
      and(
        eq(donations.teamId, current.teamId),
        ne(donations.id, current.id),
        eq(donations.provider, deps.provider.name),
        inArray(donations.status, ['pending', 'failed']),
      ),
    );
  const cancelled: string[] = [];
  for (const donation of superseded) {
    if (donation.providerRef.startsWith('pending:')) continue;
    try {
      await deps.provider.cancelPayment(donation.providerRef, { requestId: input.requestId });
      cancelled.push(donation.id);
    } catch (error) {
      deps.log.warn('superseded payment could not be cancelled', { donationId: donation.id, supersededBy: current.id, ...errorFields(error) });
    }
  }
  return cancelled;
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
