import type { Metadata } from 'next';
import Link from 'next/link';
import { Icons, LinkButton, StatusPill } from '@sideout/ui';

import { DIVISION_LABEL, FORMAT_LABEL } from '../../../components/status/labels';
import { TOURNAMENT_STATUS_PILL } from '../../../components/status/pills';
import { DataTable, type DataTableColumn } from '../../../components/ui/DataTable';
import type { TournamentStatus } from '../../../db/schema';
import { cx } from '../../../lib/cx';
import { formatCents, formatDate } from '../../../lib/format';
import { organizerPageContext } from '../../../server/pages';
import { listTournamentSummaries, type TournamentSummary } from '../../../server/screens';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Events' };

/** Console order: what needs attention first, then the pipeline, then history. */
const STATUS_ORDER = new Map<TournamentStatus, number>([
  ['live', 0],
  ['awaiting_settlement', 1],
  ['registration_closed', 2],
  ['registration_open', 3],
  ['draft', 4],
  ['settled', 5],
  ['cancelled', 6],
]);

const EMPTY_LABEL = 'No events yet. Create the first one.';

const columns: Array<DataTableColumn<TournamentSummary>> = [
  {
    key: 'event',
    header: 'Event',
    width: 'w-full min-w-40 max-w-0',
    render: (s) => (
      <Link href={`/organizer/events/${s.tournament.id}`} className="group target -my-2.5 flex min-w-0 flex-col justify-center rounded-input py-2.5">
        <span className="truncate font-medium text-text-primary group-hover:text-volt">{s.tournament.name}</span>
        <span className="truncate type-label text-text-tertiary">
          {DIVISION_LABEL[s.tournament.division]} · {FORMAT_LABEL[s.tournament.format]} · {s.tournament.venue.city}
        </span>
      </Link>
    ),
  },
  { key: 'status', header: 'Status', render: (s) => <StatusPill spec={TOURNAMENT_STATUS_PILL[s.tournament.status]} size="sm" /> },
  { key: 'date', header: 'Starts', render: (s) => <span className="tabular text-text-secondary">{formatDate(s.tournament.startsAt, s.tournament.venue.timezone)}</span> },
  { key: 'teams', header: 'Teams', numeric: true, render: (s) => `${s.tournament.teamCount}/${s.tournament.maxTeams}` },
  { key: 'live', header: 'On court', numeric: true, render: (s) => (s.liveMatchCount > 0 ? <span className="text-surf">{s.liveMatchCount}</span> : <span className="text-text-tertiary">0</span>) },
  { key: 'raised', header: 'Raised', numeric: true, render: (s) => <span className="text-ember">{formatCents(s.raisedCents, s.currency)}</span> },
  {
    key: 'actions',
    header: <span className="sr-only">Open</span>,
    align: 'end',
    render: (s) => (
      <span className="flex justify-end gap-1">
        {s.tournament.status === 'live' ? (
          <Link href={`/organizer/events/${s.tournament.id}/board`} className="target inline-flex items-center gap-1 rounded-input px-2 type-label text-text-secondary hover:text-text-primary">
            Board
          </Link>
        ) : null}
        <Link href={`/organizer/events/${s.tournament.id}`} className="target inline-flex items-center gap-1 rounded-input px-2 type-label text-text-secondary hover:text-text-primary" aria-label={`Open ${s.tournament.name}`}>
          Builder
          <Icons.chevronRight size={14} />
        </Link>
      </span>
    ),
  },
];

/** Below md, one card per event: the whole card opens the builder through the stretched link. */
function EventCard({ summary: s }: { summary: TournamentSummary }) {
  const t = s.tournament;
  return (
    <article className="surface-raised relative rounded-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} size="sm" />
        <span className="tabular type-label text-text-tertiary">{formatDate(t.startsAt, t.venue.timezone)}</span>
      </div>
      <h2 className="type-heading mt-2">
        <Link href={`/organizer/events/${t.id}`} data-target="card" className="target inline-flex items-center after:absolute after:inset-0 after:rounded-card hover:text-volt">
          {t.name}
        </Link>
      </h2>
      <p className="truncate type-label text-text-tertiary">
        {DIVISION_LABEL[t.division]} · {FORMAT_LABEL[t.format]} · {t.venue.city}
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <div>
          <dt className="type-label text-text-tertiary">Teams</dt>
          <dd className="tabular text-text-secondary">
            {t.teamCount}/{t.maxTeams}
          </dd>
        </div>
        <div>
          <dt className="type-label text-text-tertiary">On court</dt>
          <dd className={cx('tabular', s.liveMatchCount > 0 ? 'text-surf' : 'text-text-tertiary')}>{s.liveMatchCount}</dd>
        </div>
        <div>
          <dt className="type-label text-text-tertiary">Raised</dt>
          <dd className="tabular text-ember">{formatCents(s.raisedCents, s.currency)}</dd>
        </div>
      </dl>
    </article>
  );
}

export default async function OrganizerEventsPage() {
  const { app, clock } = await organizerPageContext();
  const all = (await listTournamentSummaries(app.db, clock, { includeDrafts: true })).sort((a, b) => (STATUS_ORDER.get(a.tournament.status) ?? 9) - (STATUS_ORDER.get(b.tournament.status) ?? 9) || b.tournament.startsAt.localeCompare(a.tournament.startsAt));
  const counts = new Map<TournamentStatus, number>();
  for (const s of all) counts.set(s.tournament.status, (counts.get(s.tournament.status) ?? 0) + 1);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="type-display-l">Events</h1>
          <p className="mt-1 text-text-secondary">
            <span className="tabular">{all.length}</span> events
            {[...counts.entries()].map(([status, n]) => (
              <span key={status}>
                {' · '}
                <span className="tabular">{n}</span> {TOURNAMENT_STATUS_PILL[status].label.toLowerCase()}
              </span>
            ))}
          </p>
        </div>
        <LinkButton component={Link} variant="primary" href="/organizer/events/new" iconStart={<Icons.plus size={18} />}>
          New event
        </LinkButton>
      </div>
      {all.length === 0 ? (
        <p className="surface-raised rounded-card px-4 py-6 text-text-secondary md:hidden">{EMPTY_LABEL}</p>
      ) : (
        <ul className="space-y-3 md:hidden" aria-label="Events">
          {all.map((s) => (
            <li key={s.tournament.id}>
              <EventCard summary={s} />
            </li>
          ))}
        </ul>
      )}
      <DataTable className="hidden md:block" columns={columns} rows={all} getRowKey={(s) => s.tournament.id} caption="Every event with its status, capacity, live matches and amount raised" emptyLabel={EMPTY_LABEL} />
    </div>
  );
}
