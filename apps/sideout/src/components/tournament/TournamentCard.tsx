import Link from 'next/link';
import { Icons, StatusPill } from '@sideout/ui';

import type { TournamentSummary } from '../../server/screens';
import { cx } from '../../lib/cx';
import { formatCents, formatDate, formatDateRange, formatRelative } from '../../lib/format';
import { DIVISION_LABEL, FORMAT_LABEL } from '../status/labels';
import { TOURNAMENT_STATUS_PILL } from '../status/pills';
import { ImpactMeter } from './ImpactMeter';

/** One event. Featured on Home for the live or next event; compact in lists. The whole card is the link. */
export function TournamentCard({ summary, variant = 'compact', nowMs, className }: { summary: TournamentSummary; variant?: 'featured' | 'compact'; nowMs: number; className?: string }) {
  const { tournament: t, raisedCents, donorCount, liveMatchCount, currency } = summary;
  const href = `/t/${t.slug}`;
  const featured = variant === 'featured';
  const when = t.status === 'live' ? formatDateRange(t.startsAt, t.endsAt, t.venue.timezone) : t.status === 'settled' ? formatDate(t.startsAt, t.venue.timezone) : `${formatDate(t.startsAt, t.venue.timezone)} · ${formatRelative(t.startsAt, nowMs)}`;

  return (
    <article
      data-testid="tournament-card"
      className={cx(
        'surface-raised relative rounded-card has-[a[data-target=card]:focus-visible]:outline-2 has-[a[data-target=card]:focus-visible]:outline-offset-2 has-[a[data-target=card]:focus-visible]:outline-volt',
        featured ? 'p-5 md:p-6' : 'p-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
        <span className="type-label text-text-tertiary">
          {DIVISION_LABEL[t.division]} · {FORMAT_LABEL[t.format]}
        </span>
      </div>
      <h3 className={cx('mt-3', featured ? 'type-display-l' : 'type-heading')}>
        <Link href={href} data-target="card" className="after:absolute after:inset-0 after:rounded-card hover:text-volt focus-visible:outline-none">
          {t.name}
        </Link>
      </h3>
      {t.subtitle === null ? null : <p className="mt-1 text-text-secondary">{t.subtitle}</p>}

      <dl className={cx('mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-text-secondary', featured ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2')}>
        <div className="flex items-center gap-2">
          <Icons.calendar size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">When</dt>
          <dd className="tabular">{when}</dd>
        </div>
        <div className="flex items-center gap-2">
          <Icons.mapPin size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">Where</dt>
          <dd className="truncate">
            {t.venue.city}, {t.venue.region}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Icons.users size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">Teams</dt>
          <dd className="tabular">
            {t.teamCount} of {t.maxTeams} teams
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Icons.heartHandshake size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">Beneficiary</dt>
          <dd className="truncate">{t.beneficiary.name}</dd>
        </div>
      </dl>

      {featured ? (
        <ImpactMeter className="mt-6" raisedCents={raisedCents} goalCents={t.fundraisingGoalCents} currency={currency} donorCount={donorCount} />
      ) : (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
          <span className="text-text-secondary">
            {t.status === 'settled' ? 'Raised' : 'Raised so far'} <span className="tabular font-medium text-ember">{formatCents(raisedCents, currency)}</span>
            <span className="text-text-tertiary"> of {formatCents(t.fundraisingGoalCents, currency)}</span>
          </span>
          {t.status === 'live' && liveMatchCount > 0 ? <span className="tabular type-label text-surf">{liveMatchCount} on court</span> : null}
        </div>
      )}
    </article>
  );
}
