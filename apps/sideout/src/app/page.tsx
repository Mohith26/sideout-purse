import type { Metadata } from 'next';
import { EmptyState } from '@sideout/ui';

import { LiveRefresh } from '../components/motion/LiveRefresh';
import { LiveMatchStrip } from '../components/tournament/LiveMatchStrip';
import { TournamentCard } from '../components/tournament/TournamentCard';
import { pageContext } from '../server/pages';
import { bracketRoundCount, listLiveMatches, listMatchViews, listTournamentSummaries, PAST_STATUSES, UPCOMING_STATUSES, type TournamentSummary } from '../server/screens';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Live play' };

/**
 * Home opens into the state of play (spec 5.3, item 1): the live strip when an event is in
 * progress, then the featured event, upcoming events, and past events with what each
 * raised. No hero, no marketing. While a strip is showing the page polls (decision D11)
 * so the cards' scores roll as they change.
 */
export default async function HomePage() {
  const { app, now, clock } = await pageContext();
  const summaries = await listTournamentSummaries(app.db, clock);
  // The event that started most recently comes first: what is happening now, ahead of one still open from yesterday.
  const live = summaries.filter((s) => s.tournament.status === 'live').sort((a, b) => b.tournament.startsAt.localeCompare(a.tournament.startsAt));
  const strips = await Promise.all(
    live.map(async (summary) => {
      const [matches, all] = await Promise.all([listLiveMatches(app.db, summary.tournament.id), listMatchViews(app.db, summary.tournament.id)]);
      return { summary, matches, bracketRounds: bracketRoundCount(all) };
    }),
  );
  const upcoming = summaries.filter((s) => UPCOMING_STATUSES.includes(s.tournament.status)).sort((a, b) => a.tournament.startsAt.localeCompare(b.tournament.startsAt));
  const past = summaries.filter((s) => PAST_STATUSES.includes(s.tournament.status)).sort((a, b) => b.tournament.startsAt.localeCompare(a.tournament.startsAt));
  const featured: TournamentSummary | undefined = strips[0]?.summary ?? upcoming[0];
  const otherUpcoming = upcoming.filter((s) => s !== featured);
  const nowMs = now.getTime();

  return (
    <>
      <h1 className="sr-only">Live play</h1>
      {strips.length > 0 ? <LiveRefresh /> : null}
      {strips.map((strip) => (
        <LiveMatchStrip key={strip.summary.tournament.id} tournamentName={strip.summary.tournament.name} slug={strip.summary.tournament.slug} matches={strip.matches} bracketRounds={strip.bracketRounds} />
      ))}

      <div className="space-y-10">
        {featured === undefined ? (
          <EmptyState level={2} icon="calendar" title="No events scheduled" body="When an organizer opens registration, it shows up here first." />
        ) : (
          <section aria-labelledby="featured-heading">
            <h2 id="featured-heading" className="type-label mb-3 text-text-tertiary">
              {featured.tournament.status === 'live' ? 'Happening now' : 'Next up'}
            </h2>
            <TournamentCard summary={featured} variant="featured" nowMs={nowMs} />
          </section>
        )}

        {otherUpcoming.length > 0 ? (
          <section aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className="type-label mb-3 text-text-tertiary">
              Upcoming
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {otherUpcoming.map((s) => (
                <TournamentCard key={s.tournament.id} summary={s} nowMs={nowMs} />
              ))}
            </div>
          </section>
        ) : null}

        {past.length > 0 ? (
          <section aria-labelledby="past-heading">
            <h2 id="past-heading" className="type-label mb-3 text-text-tertiary">
              Past events
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {past.map((s) => (
                <TournamentCard key={s.tournament.id} summary={s} nowMs={nowMs} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
