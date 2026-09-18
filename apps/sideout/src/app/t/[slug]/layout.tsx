import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { TournamentHeader } from '../../../components/tournament/TournamentHeader';
import { pageContext } from '../../../server/pages';
import { findVisibleTournament, tournamentPage } from './_lib';

export const dynamic = 'force-dynamic';

/** Metadata never calls `notFound()`: a thrown lookup here leaves the not-found screen without a `<title>`. The layout body does the refusing. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { app, user } = await pageContext();
  const row = await findVisibleTournament(app.db, slug, user);
  if (row === null) return { title: 'Not found' };
  const { tournament: t, beneficiary } = row;
  return { title: t.name, description: `${t.name} benefiting ${beneficiary.name}: ${t.venueName}, ${t.venueCity}.` };
}

/** Sticky header shared by the four tabs (spec 5.3, "Tournament"). */
export default async function TournamentLayout({ params, children }: { params: Promise<{ slug: string }>; children: ReactNode }) {
  const { slug } = await params;
  const { summary, now } = await tournamentPage(slug);
  return (
    <>
      <TournamentHeader tournament={summary.tournament} nowMs={now.getTime()} liveMatchCount={summary.liveMatchCount} />
      <div className="pt-6 md:pt-8">{children}</div>
    </>
  );
}
