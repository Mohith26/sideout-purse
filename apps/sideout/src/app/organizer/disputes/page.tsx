import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { EmptyState } from '@sideout/ui';

import { DisputeCard, type DisputeCardData } from '../../../components/consensus/DisputeCard';
import { LiveRefresh } from '../../../components/motion/LiveRefresh';
import { tournaments } from '../../../db/schema';
import { bracketRoundLabel } from '../../../lib/rounds';
import { listDisputes } from '../../../server/consensus';
import { organizerPageContext } from '../../../server/pages';
import { bracketRoundCount, listMatchViews } from '../../../server/screens';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Disputes' };

/** The dispute queue (spec 5.3, item 6): every match whose two teams disagree, oldest first, with both readings side by side, whether a checked-in phone signed each, and the organizer's resolution. */
export default async function DisputesPage() {
  const { app } = await organizerPageContext();
  const disputes = await listDisputes(app.db);
  const byTournament = new Map<string, { rounds: number; timeZone: string }>();
  for (const d of disputes) {
    if (byTournament.has(d.tournament.id)) continue;
    const [row] = await app.db.select({ timeZone: tournaments.venueTimezone }).from(tournaments).where(eq(tournaments.id, d.tournament.id));
    byTournament.set(d.tournament.id, { rounds: bracketRoundCount(await listMatchViews(app.db, d.tournament.id)), timeZone: row?.timeZone ?? 'UTC' });
  }
  const cards: DisputeCardData[] = disputes.map((d) => {
    const meta = byTournament.get(d.tournament.id) ?? { rounds: 0, timeZone: 'UTC' };
    return {
      match: { id: d.match.id, bestOf: d.match.bestOf === 3 ? 3 : 1, courtLabel: d.match.courtLabel, teamAId: d.match.teamAId, teamBId: d.match.teamBId },
      tournament: { name: d.tournament.name, slug: d.tournament.slug },
      roundLabel: d.poolLabel === null ? bracketRoundLabel(d.match.round, meta.rounds) : `${d.poolLabel} · round ${d.match.round}`,
      teamA: d.teamA,
      teamB: d.teamB,
      disputedReason: d.consensus.disputedReason,
      differences: d.consensus.differences.map((x) => x.setNumber),
      submissions: d.consensus.live.map((s) => ({ teamId: s.teamId, sets: s.sets, submittedBy: s.submittedBy.displayName, createdAt: s.createdAt, attested: s.attestation !== null })),
      timeZone: meta.timeZone,
    };
  });
  return (
    <div className="space-y-6">
      <LiveRefresh source={{ kind: 'all' }} intervalMs={15_000} />
      <div>
        <h1 className="type-display-l">Disputes</h1>
        <p className="mt-1 text-text-secondary">
          {cards.length === 0 ? 'Nothing to settle. Every scored match has both teams agreeing.' : `${cards.length} ${cards.length === 1 ? 'match' : 'matches'} where the two readings differ. Settle each with the scoreline you can verify; the result is final and pushed to Purse.`}
        </p>
      </div>
      {cards.length === 0 ? (
        <EmptyState level={2} icon="circleCheck" title="The queue is empty" body="A dispute appears here the moment two teams submit different scorelines for the same match." />
      ) : (
        <div className="space-y-4">
          {cards.map((card) => (
            <DisputeCard key={card.match.id} dispute={card} />
          ))}
        </div>
      )}
    </div>
  );
}
