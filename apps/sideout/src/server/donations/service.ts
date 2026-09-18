import { and, count, desc, eq, inArray, ne, sum } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../../db/client';
import { donationProviderEvents, donations, teams, users, type Donation, type DonationStatus } from '../../db/schema';
import { SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { DbOrTx } from '../db';
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

export type ApplyStatusResult = { changed: boolean; donation: Donation; previous: DonationStatus };

/**
 * Move a donation to `status` if the transition is legal, and keep its team's
 * registration in step: a succeeded entry donation confirms the team, a failed one with
 * no other live payment releases the spot, a refund withdraws the team.
 */
export async function applyDonationStatus(tx: DbOrTx, input: { donationId: string; status: DonationStatus; now: Date }): Promise<ApplyStatusResult> {
  const [donation] = await tx.select().from(donations).where(eq(donations.id, input.donationId)).for('update');
  if (donation === undefined) throw new Error(`donation ${input.donationId} not found`);
  const previous = donation.status;
  if (previous === input.status || !DONATION_TRANSITIONS[previous].includes(input.status)) {
    return { changed: false, donation, previous };
  }
  const [updated] = await tx
    .update(donations)
    .set({ status: input.status, updatedAt: input.now })
    .where(eq(donations.id, donation.id))
    .returning();
  if (updated === undefined) throw new Error('donation update returned no row');

  if (donation.teamId !== null) {
    await syncTeamRegistration(tx, { teamId: donation.teamId, donation: updated, now: input.now });
  }
  return { changed: true, donation: updated, previous };
}

async function syncTeamRegistration(tx: DbOrTx, input: { teamId: string; donation: Donation; now: Date }): Promise<void> {
  const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId)).for('update');
  if (team === undefined) return;

  if (input.donation.status === 'succeeded' && team.status === 'forming') {
    await tx.update(teams).set({ status: 'registered', registeredAt: team.registeredAt ?? input.now, updatedAt: input.now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: 'forming', to: 'registered', reason: 'donation_succeeded', donationId: input.donation.id },
      at: input.now,
    });
    return;
  }

  if (input.donation.status === 'failed' && team.status === 'registered') {
    const [live] = await tx
      .select({ n: count() })
      .from(donations)
      .where(and(eq(donations.teamId, team.id), ne(donations.id, input.donation.id), inArray(donations.status, ['pending', 'succeeded'])));
    if ((live?.n ?? 0) > 0) return;
    await tx.update(teams).set({ status: 'forming', registeredAt: null, updatedAt: input.now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: 'registered', to: 'forming', reason: 'donation_failed', donationId: input.donation.id },
      at: input.now,
    });
    return;
  }

  if (input.donation.status === 'refunded' && (team.status === 'registered' || team.status === 'checked_in')) {
    await tx.update(teams).set({ status: 'withdrawn', updatedAt: input.now }).where(eq(teams.id, team.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.id,
      detail: { from: team.status, to: 'withdrawn', reason: 'donation_refunded', donationId: input.donation.id },
      at: input.now,
    });
  }
}

export type WebhookOutcome =
  | { duplicate: true }
  | { duplicate: false; applied: false; reason: 'ignored_event_type' | 'unknown_payment_intent' | 'no_transition' }
  | { duplicate: false; applied: true; donationId: string; from: DonationStatus; to: DonationStatus };

/**
 * Apply one verified Stripe event, idempotently on `event.id`: the event row is inserted
 * first (a conflict means it was already processed) and the donation change rides the
 * same transaction, so a crash between the two leaves nothing half-applied.
 */
export async function applyStripeEvent(db: Db, event: StripeEvent, now: Date): Promise<WebhookOutcome> {
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
    const result = await applyDonationStatus(tx, { donationId: donation.id, status: interpreted.status, now });
    if (!result.changed) return { duplicate: false, applied: false, reason: 'no_transition' };

    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: `donation.${interpreted.status}`,
      subjectType: 'donation',
      subjectId: donation.id,
      detail: { provider: 'stripe', eventId: event.id, eventType: event.type, from: result.previous },
      at: now,
    });
    return { duplicate: false, applied: true, donationId: donation.id, from: result.previous, to: interpreted.status };
  });
}

// ---- Derived figures ----------------------------------------------------------------------

export type DonationTotals = { raisedCents: bigint; donationCount: number };

/** Sum of succeeded donations. Pending, failed and refunded rows contribute nothing. */
export async function donationTotals(db: DbOrTx, tournamentId: string): Promise<DonationTotals> {
  const [row] = await db
    .select({ raised: sum(donations.amountCents), n: count() })
    .from(donations)
    .where(and(eq(donations.tournamentId, tournamentId), eq(donations.status, 'succeeded')));
  return { raisedCents: BigInt(row?.raised ?? '0'), donationCount: row?.n ?? 0 };
}

export type Donor = { displayName: string | null; amountCents: bigint; at: Date };

/** The most recent succeeded donations with the donor's name where one is on file. */
export async function recentDonors(db: DbOrTx, tournamentId: string, limit = 20): Promise<Donor[]> {
  const rows = await db
    .select({ displayName: users.displayName, amountCents: donations.amountCents, at: donations.updatedAt })
    .from(donations)
    .leftJoin(users, eq(users.id, donations.userId))
    .where(and(eq(donations.tournamentId, tournamentId), eq(donations.status, 'succeeded')))
    .orderBy(desc(donations.updatedAt))
    .limit(limit);
  return rows.map((r) => ({ displayName: r.displayName, amountCents: r.amountCents, at: r.at }));
}
