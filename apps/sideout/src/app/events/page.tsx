import type { Metadata } from 'next';
import { EmptyState } from '@sideout/ui';

import { TournamentCard } from '../../components/tournament/TournamentCard';
import type { TournamentStatus } from '../../db/schema';
import { pageContext } from '../../server/pages';
import { listTournamentSummaries } from '../../server/screens';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Events' };

const GROUPS: ReadonlyArray<{ key: string; label: string; statuses: readonly TournamentStatus[]; order: 'asc' | 'desc' }> = [
  { key: 'live', label: 'Live', statuses: ['live'], order: 'asc' },
  { key: 'upcoming', label: 'Upcoming', statuses: ['registration_open', 'registration_closed'], order: 'asc' },
  { key: 'past', label: 'Past', statuses: ['awaiting_settlement', 'settled', 'cancelled'], order: 'desc' },
];

export default async function EventsPage() {
  const { app, now, clock } = await pageContext();
  const all = await listTournamentSummaries(app.db, clock);
  const groups = GROUPS.map((g) => ({
    ...g,
    items: all.filter((s) => g.statuses.includes(s.tournament.status)).sort((a, b) => (g.order === 'asc' ? a.tournament.startsAt.localeCompare(b.tournament.startsAt) : b.tournament.startsAt.localeCompare(a.tournament.startsAt))),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-10">
      <h1 className="type-display-l">Events</h1>
      {groups.length === 0 ? (
        <EmptyState level={2} icon="calendar" title="No events yet" body="Events appear here once an organizer opens registration." />
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-labelledby={`events-${g.key}`}>
            <h2 id={`events-${g.key}`} className="type-label mb-3 text-text-tertiary">
              {g.label} · <span className="tabular">{g.items.length}</span>
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {g.items.map((s) => (
                <TournamentCard key={s.tournament.id} summary={s} nowMs={now.getTime()} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
