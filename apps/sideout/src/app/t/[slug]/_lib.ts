import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import { charities, tournaments, type Charity, type Tournament, type User } from '../../../db/schema';
import type { DbOrTx } from '../../../server/db';
import { pageContext, type PageContext } from '../../../server/pages';
import { tournamentSummary, type TournamentSummary } from '../../../server/screens';

/**
 * The tournament a `/t/[slug]` render may show to the current viewer: a draft is
 * unpublished, exactly as the API answers, but an organizer may open it to preview what
 * the page will show. Anything else is 404.
 */
export async function findVisibleTournament(db: DbOrTx, slug: string, user: User | null): Promise<{ tournament: Tournament; beneficiary: Charity } | null> {
  const [row] = await db.select({ tournament: tournaments, beneficiary: charities }).from(tournaments).innerJoin(charities, eq(charities.id, tournaments.beneficiaryId)).where(eq(tournaments.slug, slug));
  if (row === undefined) return null;
  if (row.tournament.status === 'draft' && user?.role !== 'organizer') return null;
  return row;
}

export type TournamentPage = PageContext & { row: { tournament: Tournament; beneficiary: Charity }; summary: TournamentSummary };

/** Resolve the tournament for a tab page, or 404. */
export async function tournamentPage(slug: string): Promise<TournamentPage> {
  const context = await pageContext();
  const row = await findVisibleTournament(context.app.db, slug, context.user);
  if (row === null) notFound();
  const summary = await tournamentSummary(context.app.db, row.tournament, row.beneficiary, context.clock);
  return { ...context, row, summary };
}
