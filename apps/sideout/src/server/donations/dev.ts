import { randomUUID } from 'node:crypto';

import { and, asc, eq, lte } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { donations } from '../../db/schema';
import { SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { ReservationClock } from '../field';
import type { DonationProvider } from './provider';
import { applyDonationStatus } from './service';

/**
 * The development provider. A payment is accepted as pending and becomes `succeeded`
 * once `DEV_SETTLE_DELAY_MS` has passed, so the pending state is exercised locally and
 * the transition is driven by the clock the caller passes, never by a timer. Cancelling
 * a payment marks its row `failed` at once (what Stripe's `payment_intent.canceled` event
 * does for the real provider), so a superseded dev payment is never settled later.
 *
 * Selected in production only under the public demo's `DEMO_ACCOUNTS` switch (`env.ts`,
 * `docs/demo-accounts.md`), where a configured Stripe key still wins, so this can never
 * mark a real donation paid.
 */
export const DEV_SETTLE_DELAY_MS = 15_000;

export function devDonationProvider(deps: { db: Db; reservationTtlMs: number }): DonationProvider {
  return {
    name: 'dev',
    createPayment: async () => {
      await Promise.resolve();
      return { providerRef: `dev_${randomUUID()}`, clientSecret: null, status: 'pending' };
    },
    retrievePayment: async (providerRef) => {
      const [donation] = await deps.db.select({ status: donations.status }).from(donations).where(and(eq(donations.provider, 'dev'), eq(donations.providerRef, providerRef)));
      return { providerRef, clientSecret: null, status: donation?.status === 'succeeded' ? 'succeeded' : 'pending' };
    },
    cancelPayment: async (providerRef) => {
      const clock: ReservationClock = { now: new Date(), reservationTtlMs: deps.reservationTtlMs };
      await deps.db.transaction(async (tx) => {
        const [donation] = await tx
          .select({ id: donations.id })
          .from(donations)
          .where(and(eq(donations.provider, 'dev'), eq(donations.providerRef, providerRef), eq(donations.status, 'pending')));
        if (donation === undefined) return;
        const result = await applyDonationStatus(tx, { donationId: donation.id, status: 'failed', clock });
        if (!result.changed) return;
        await writeAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'donation.failed',
          subjectType: 'donation',
          subjectId: donation.id,
          detail: { provider: 'dev', reason: 'cancelled', registration: result.registration },
          at: clock.now,
        });
      });
    },
  };
}

/**
 * Settle every pending dev donation whose delay has elapsed as of the clock, oldest
 * first. The read paths that report donation status call this first, which is the same
 * "reconcile before you report" step a production deploy performs against the provider's
 * own records.
 */
export async function settleDueDevDonations(db: Db, clock: ReservationClock): Promise<string[]> {
  const now = clock.now;
  const cutoff = new Date(now.getTime() - DEV_SETTLE_DELAY_MS);
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: donations.id })
      .from(donations)
      .where(and(eq(donations.provider, 'dev'), eq(donations.status, 'pending'), lte(donations.createdAt, cutoff)))
      .orderBy(asc(donations.createdAt), asc(donations.id))
      .for('update');
    const settled: string[] = [];
    for (const { id } of due) {
      const result = await applyDonationStatus(tx, { donationId: id, status: 'succeeded', clock });
      if (result.changed) {
        settled.push(id);
        await writeAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'donation.succeeded',
          subjectType: 'donation',
          subjectId: id,
          detail: { provider: 'dev', reason: 'dev provider delay elapsed', registration: result.registration, refundDue: result.refundDue },
          at: now,
        });
      }
    }
    return settled;
  });
}
