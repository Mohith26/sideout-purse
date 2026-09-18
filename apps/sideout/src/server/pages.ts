import { notFound } from 'next/navigation';

import type { User } from '../db/schema';
import { pageUser } from './auth/current-user';
import { appContext, type AppContext } from './context';
import { settleDueDevDonations } from './donations/dev';
import type { ReservationClock } from './field';

/**
 * What every server-rendered screen starts from: the app context, the request's clock,
 * the signed-in user (null for a visitor), and the reservation clock capacity reads with.
 * The dev donation provider settles due donations here first, the same "reconcile before
 * you report" step the API routes take (docs/decisions.md, phase 6), so a screen never
 * shows a pending gift the provider would already call received.
 */
export type PageContext = { app: AppContext; user: User | null; now: Date; clock: ReservationClock };

export async function pageContext(): Promise<PageContext> {
  const app = appContext();
  const now = new Date();
  const clock: ReservationClock = { now, reservationTtlMs: app.env.reservationTtlMs };
  const user = await pageUser({ db: app.db, sessionSecret: app.env.sessionSecret, now });
  if (app.donationProvider?.name === 'dev') await settleDueDevDonations(app.db, clock);
  return { app, user, now, clock };
}

/** The console is role-gated on the server: a player, or anyone signed out, gets the same 404 an unknown path gives. */
export async function organizerPageContext(): Promise<PageContext & { user: User }> {
  const context = await pageContext();
  if (context.user?.role !== 'organizer') notFound();
  return { ...context, user: context.user };
}

/** What the browser needs to mount a Purse flow (all public by design), or null when the server has no publishable key. */
export function purseBrowserConfig(app: AppContext): { publishableKey: string; tenantId: string; purseOrigin: string } | null {
  const { purse } = app.env;
  if (purse.publishableKey === undefined || app.purse === null) return null;
  return { publishableKey: purse.publishableKey, tenantId: purse.tenantId, purseOrigin: purse.browserOrigin };
}

/**
 * Responsible-play and support links (spec 5.3, "Profile"). They point at the Purse origin,
 * the platform that holds the wallet and the restrictions; phase 9's hosting gives Purse
 * those pages (docs/decisions.md, phase 8).
 */
export function purseLinks(app: AppContext): { supportHref: string; policyHref: string; selfLimitHref: string } {
  const origin = app.env.purse.browserOrigin;
  return { supportHref: `${origin}/support`, policyHref: `${origin}/responsible-play`, selfLimitHref: `${origin}/responsible-play#limits` };
}
