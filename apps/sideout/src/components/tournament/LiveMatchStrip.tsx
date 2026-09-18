import Link from 'next/link';
import { Icons, LiveDot } from '@sideout/ui';

import { MatchCard, type MatchCardView } from './MatchCard';

/**
 * The top of Home while an event is in progress (spec 5.3, "live-first"): what is on the
 * sand right now and what is waiting for a result. Home polls while a strip is showing, so
 * the cards' scores roll to each new value and the list announces changes politely.
 */
export function LiveMatchStrip({ tournamentName, slug, matches, bracketRounds }: { tournamentName: string; slug: string; matches: readonly MatchCardView[]; bracketRounds: number }) {
  if (matches.length === 0) return null;
  const inPlay = matches.filter((m) => m.match.status === 'in_progress').length;
  return (
    <section aria-labelledby={`live-strip-${slug}`} data-testid="live-strip" className="-mx-gutter -mt-5 mb-6 border-b border-border-subtle bg-bg-inset md:-mt-6">
      <div className="mx-auto max-w-content px-gutter py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`live-strip-${slug}`} className="flex items-center gap-2 truncate type-label text-surf">
              <LiveDot />
              Live · {tournamentName}
            </h2>
            <p className="mt-1 type-label text-text-tertiary">
              <span className="tabular">{inPlay}</span> on court · <span className="tabular">{matches.length - inPlay}</span> awaiting a result
            </p>
          </div>
          <Link href={`/t/${slug}`} className="target inline-flex shrink-0 items-center gap-1 type-label text-text-secondary hover:text-text-primary">
            Event
            <Icons.chevronRight size={14} />
          </Link>
        </div>
        <ul aria-live="polite" aria-atomic="false" className="relative -mx-gutter mt-3 flex snap-x gap-3 overflow-x-auto px-gutter pb-1 [scrollbar-width:thin]">
          {matches.map((m) => (
            <li key={m.match.id} className="snap-start">
              <Link href={`/m/${m.match.id}`} className="block rounded-card" aria-label={`Open match: ${m.teamA?.name ?? 'TBD'} vs ${m.teamB?.name ?? 'TBD'}`}>
                <MatchCard view={m} bracketRounds={bracketRounds} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
