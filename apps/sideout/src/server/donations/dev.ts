import { randomUUID } from 'node:crypto';

import { and, eq, lte } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { donations } from '../../db/schema';
import { SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { DonationProvider } from './provider';
import { applyDonationStatus } from './service';

/**
 * The development provider. A payment is accepted as pending and becomes `succeeded`
 * once `DEV_SETTLE_DELAY_MS` has passed, so the pending state is exercised locally and
 * the transition is driven by the clock the caller passes, never by a timer.
 *
 * Never selected in production (`env.ts`), so this can never mark a real donation paid.
 */
export const DEV_SETTLE_DELAY_MS = 15_000;

export const devDonationProvider: DonationProvider = {
  name: 'dev',
  createPayment: async () => {
    await Promise.resolve();
    return { providerRef: `dev_${randomUUID()}`, clientSecret: null, status: 'pending' };
  },
};

/**
 * Settle every pending dev donation whose delay has elapsed as of `now`. The read paths
 * that report donation status call this first, which is the same "reconcile before you
 * report" step a production deploy performs against the provider's own records.
 */
export async function settleDueDevDonations(db: Db, now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - DEV_SETTLE_DELAY_MS);
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: donations.id })
      .from(donations)
      .where(and(eq(donations.provider, 'dev'), eq(donations.status, 'pending'), lte(donations.createdAt, cutoff)))
      .for('update');
    const settled: string[] = [];
    for (const { id } of due) {
      const result = await applyDonationStatus(tx, { donationId: id, status: 'succeeded', now });
      if (result.changed) {
        settled.push(id);
        await writeAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'donation.succeeded',
          subjectType: 'donation',
          subjectId: id,
          detail: { provider: 'dev', reason: 'dev provider delay elapsed' },
          at: now,
        });
      }
    }
    return settled;
  });
}
