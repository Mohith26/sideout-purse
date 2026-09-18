import { LiveDot, StatusPill } from '@sideout/ui';

import type { PublicTournament } from '../../server/public-shape';
import { formatDate, formatDateRange } from '../../lib/format';
import { TOURNAMENT_STATUS_PILL } from '../status/pills';
import { Countdown } from './Countdown';
import { TabNav } from './TabNav';

/** Sticky event header (spec 5.3, "Tournament"): name, beneficiary, status, and a countdown or live indicator, then the four tabs. */
export function TournamentHeader({ tournament: t, nowMs, liveMatchCount }: { tournament: PublicTournament; nowMs: number; liveMatchCount: number }) {
  const base = `/t/${t.slug}`;
  const tabs = [
    { href: base, label: 'Overview', exact: true },
    { href: `${base}/bracket`, label: 'Bracket' },
    { href: `${base}/standings`, label: 'Standings' },
    { href: `${base}/impact`, label: 'Impact' },
  ];
  const upcoming = t.status === 'draft' || t.status === 'registration_open' || t.status === 'registration_closed';
  return (
    <div className="sticky top-0 z-30 -mx-gutter -mt-5 border-b border-border-subtle bg-bg-base md:-mt-6" data-testid="tournament-header">
      <div className="mx-auto max-w-content px-gutter pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          {t.status === 'live' ? (
            <span className="tabular inline-flex items-center gap-2 type-label text-surf">
              <LiveDot />
              {liveMatchCount} {liveMatchCount === 1 ? 'match' : 'matches'} on court
            </span>
          ) : upcoming ? (
            <Countdown targetIso={t.startsAt} initialNowMs={nowMs} />
          ) : (
            <span className="tabular type-label text-text-tertiary">{formatDate(t.startsAt, t.venue.timezone)}</span>
          )}
        </div>
        <h1 className="type-display-l mt-2">{t.name}</h1>
        <p className="mt-1 text-text-secondary">
          Benefiting <span className="text-text-primary">{t.beneficiary.name}</span>
          <span className="text-text-tertiary"> · {t.venue.name}</span>
          <span className="tabular text-text-tertiary"> · {formatDateRange(t.startsAt, t.endsAt, t.venue.timezone)}</span>
        </p>
        <div className="mt-3">
          <TabNav items={tabs} ariaLabel={`${t.name} sections`} />
        </div>
      </div>
    </div>
  );
}
