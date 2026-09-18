import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, Icons, StatusPill } from '@sideout/ui';

import { TOURNAMENT_STATUS_PILL } from '../../components/status/pills';
import { ImpactMeter } from '../../components/tournament/ImpactMeter';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { formatCents, formatDate, formatPercent } from '../../lib/format';
import { globalImpact, type GlobalImpact } from '../../server/impact';
import { pageContext } from '../../server/pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Impact' };

type EventRow = GlobalImpact['perEvent'][number];

export default async function ImpactPage() {
  const { app, clock } = await pageContext();
  const impact = await globalImpact(app.db, clock);
  const columns: Array<DataTableColumn<EventRow>> = [
    {
      key: 'event',
      header: 'Event',
      render: (r) => (
        <Link href={`/t/${r.tournament.slug}`} className="target -my-2.5 flex items-center py-2.5 font-medium text-text-primary hover:text-volt">
          {r.tournament.name}
        </Link>
      ),
    },
    { key: 'status', header: 'Status', hideBelowMd: true, render: (r) => <StatusPill spec={TOURNAMENT_STATUS_PILL[r.tournament.status]} size="sm" /> },
    { key: 'date', header: 'Date', hideBelowMd: true, render: (r) => <span className="tabular text-text-secondary">{formatDate(r.tournament.startsAt, r.tournament.venue.timezone)}</span> },
    { key: 'gifts', header: 'Gifts', numeric: true, render: (r) => r.donorCount },
    { key: 'raised', header: 'Raised', numeric: true, render: (r) => <span className="text-ember">{formatCents(r.raisedCents, impact.currency)}</span> },
    { key: 'goal', header: 'Of goal', numeric: true, render: (r) => <span className="text-text-secondary">{formatPercent(r.progressPercent)}</span> },
  ];

  return (
    <div className="space-y-10">
      <div>
        <h1 className="type-display-l">Impact</h1>
        <p className="mt-2 max-w-prose text-text-secondary">
          Every entry fee is a charitable donation and every event has a beneficiary. Totals here are sums of completed gifts across all events; contest prizes are POINTS in Purse and never touch a donation.
        </p>
      </div>

      {impact.charity === null ? (
        <EmptyState level={2} icon="heartHandshake" title="No beneficiary yet" />
      ) : (
        <section aria-labelledby="beneficiary-heading" className="surface-raised rounded-card p-5 md:p-6">
          <h2 id="beneficiary-heading" className="type-label text-text-tertiary">
            Beneficiary
          </h2>
          <p className="type-heading mt-1">{impact.charity.name}</p>
          {impact.charity.description === null ? null : <p className="mt-2 max-w-prose text-text-secondary">{impact.charity.description}</p>}
          {impact.charity.websiteUrl === null ? null : (
            <a href={impact.charity.websiteUrl} target="_blank" rel="noreferrer noopener" className="target mt-3 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt">
              Visit their site
              <Icons.externalLink size={14} />
            </a>
          )}
          <ImpactMeter className="mt-6" raisedCents={impact.totalRaisedCents} goalCents={impact.totalGoalCents} currency={impact.currency} donorCount={impact.donorCount} />
        </section>
      )}

      <section aria-labelledby="per-event-heading">
        <h2 id="per-event-heading" className="type-label mb-3 text-text-tertiary">
          By event
        </h2>
        <DataTable columns={columns} rows={impact.perEvent} getRowKey={(r) => r.tournament.id} caption="Amount raised per event" emptyLabel="No events yet." />
      </section>
    </div>
  );
}
