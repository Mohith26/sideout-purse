import { asc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icons, SectionHeading, StatusPill } from '@sideout/ui';

import { DrawPanel } from '../../../../components/organizer/DrawPanel';
import { EventForm, type EventFormValues } from '../../../../components/organizer/EventForm';
import { centsToDollars, toWallClock } from '../../../../components/organizer/event-form-values';
import { StatusActions } from '../../../../components/organizer/StatusActions';
import { TOURNAMENT_STATUS_PILL } from '../../../../components/status/pills';
import { Stat } from '../../../../components/ui/Stat';
import { charities, DIVISIONS, sponsors, teams, tournaments } from '../../../../db/schema';
import { DRAWABLE_FORMATS } from '../../../../domain/draw';
import { formatCents, formatDateRange, sumCents } from '../../../../lib/format';
import { confirmedTeamsFilter } from '../../../../server/field';
import { organizerPageContext, pageContext } from '../../../../server/pages';
import { listMatchViews, tournamentSummary } from '../../../../server/screens';
import { isMatchComplete } from '../../../../domain/state';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  // Never `notFound()` from metadata (it would leave the not-found screen untitled); the page body refuses a stranger.
  const { app, user } = await pageContext();
  if (user?.role !== 'organizer') return { title: 'Not found' };
  const [row] = await app.db.select({ name: tournaments.name }).from(tournaments).where(eq(tournaments.id, id));
  return { title: row?.name ?? 'Event' };
}

/**
 * Event builder, edit mode (spec 5.3, item 6): the status controls with the validator's
 * allowed targets, the draw section with its live preview, and every editable field.
 * Reads are server-rendered; writes go through the admin routes from the client
 * components.
 */
export default async function EventBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { app, clock } = await organizerPageContext();
  const { db } = app;
  const [row] = await db.select({ tournament: tournaments, beneficiary: charities }).from(tournaments).innerJoin(charities, eq(charities.id, tournaments.beneficiaryId)).where(eq(tournaments.id, id));
  if (row === undefined) notFound();
  const t = row.tournament;
  const [summary, views, sponsorRows, beneficiaries, confirmed] = await Promise.all([
    tournamentSummary(db, t, row.beneficiary, clock),
    listMatchViews(db, t.id),
    db.select().from(sponsors).where(eq(sponsors.tournamentId, t.id)).orderBy(asc(sponsors.createdAt)),
    db.select({ id: charities.id, name: charities.name }).from(charities).where(eq(charities.status, 'active')).orderBy(asc(charities.name)),
    db.select({ id: teams.id, name: teams.name, seed: teams.seed }).from(teams).where(confirmedTeamsFilter(t.id)).orderBy(asc(teams.seed), asc(teams.createdAt)),
  ]);
  const started = views.some((v) => v.match.status !== 'scheduled' && v.match.status !== 'bye');
  const poolMatches = views.filter((v) => v.match.poolId !== null);
  const unfinishedPool = poolMatches.filter((v) => !isMatchComplete(v.match.status)).length;
  const bracketMatches = views.filter((v) => v.match.bracketPosition !== null);
  const bracketSeeded = bracketMatches.some((v) => v.teamA !== null || v.teamB !== null);
  const readOnly = t.status === 'settled' || t.status === 'cancelled';
  const drawStage = t.status === 'registration_closed' || (t.status === 'live' && t.format === 'pool_to_bracket' && !bracketSeeded && views.length > 0);
  const initial: EventFormValues = {
    slug: t.slug,
    name: t.name,
    subtitle: t.subtitle ?? '',
    beneficiaryId: t.beneficiaryId,
    venueName: t.venueName,
    venueCity: t.venueCity,
    venueRegion: t.venueRegion,
    venueTimezone: t.venueTimezone,
    startsAt: toWallClock(t.startsAt.toISOString(), t.venueTimezone),
    endsAt: toWallClock(t.endsAt.toISOString(), t.venueTimezone),
    format: t.format,
    division: t.division,
    maxTeams: String(t.maxTeams),
    entryDonation: centsToDollars(t.entryDonationCents.toString()),
    fundraisingGoal: centsToDollars(t.fundraisingGoalCents.toString()),
  };

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/organizer/events" className="target inline-flex items-center gap-1 rounded-input type-label text-text-secondary hover:text-text-primary">
            <Icons.chevronLeft size={14} />
            Events
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-display-l">{t.name}</h1>
            <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          </div>
          <p className="mt-1 text-text-secondary">
            {row.beneficiary.name} · {t.venueName} · <span className="tabular">{formatDateRange(t.startsAt, t.endsAt, t.venueTimezone)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.status === 'draft' ? null : (
            <Link href={`/t/${t.slug}`} className="target surface-raised inline-flex items-center gap-2 rounded-input px-3 type-label text-text-secondary hover:text-text-primary">
              Public page
              <Icons.externalLink size={14} />
            </Link>
          )}
          {views.length > 0 ? (
            <Link href={`/organizer/events/${t.id}/board`} className="target surface-raised inline-flex items-center gap-2 rounded-input px-3 type-label text-text-secondary hover:text-text-primary">
              <Icons.grid size={14} />
              Live board
            </Link>
          ) : null}
          {t.status === 'draft' ? null : (
            <Link href={`/organizer/events/${t.id}/close`} className="target surface-raised inline-flex items-center gap-2 rounded-input px-3 type-label text-text-secondary hover:text-text-primary">
              <Icons.shieldCheck size={14} />
              Purse and close
            </Link>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Teams" value={`${summary.tournament.teamCount} of ${t.maxTeams}`} hint={`${confirmed.length} confirmed`} />
        <Stat label="Matches" value={String(views.length)} hint={views.length > 0 ? `${poolMatches.length} pool · ${bracketMatches.length} bracket` : 'No draw yet'} />
        <Stat label="Raised" value={formatCents(summary.raisedCents, summary.currency)} hint={`${summary.donorCount} gifts · goal ${formatCents(t.fundraisingGoalCents, summary.currency)}`} tone="ember" />
        <Stat label="Sponsors" value={String(sponsorRows.length)} hint={`${formatCents(sumCents(sponsorRows.map((s) => s.prizeContributionCents)), summary.currency)} shapes the prize split`} />
      </dl>

      <section aria-labelledby="status-heading" className="surface-raised rounded-card p-4 md:p-5">
        <SectionHeading id="status-heading">Status</SectionHeading>
        <StatusActions tournamentId={t.id} status={t.status} matchCount={views.length} />
      </section>

      <section aria-labelledby="draw-heading" className="surface-raised rounded-card p-4 md:p-5">
        <h2 id="draw-heading" className={drawStage ? 'sr-only' : 'so-section-heading'}>
          {drawStage ? 'Draw' : <span className="type-label text-text-tertiary">Draw</span>}
        </h2>
        {drawStage ? (
          <DrawPanel
            tournamentId={t.id}
            format={t.format}
            status={t.status}
            timeZone={t.venueTimezone}
            teams={confirmed}
            existing={{ matchCount: views.length, started, bracketSeeded, poolsDone: poolMatches.length > 0 && unfinishedPool === 0, unfinishedPoolMatches: unfinishedPool, config: t.drawConfig }}
          />
        ) : null}
        {views.length > 0 ? (
          <div className={drawStage ? 'mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4' : 'flex flex-wrap items-center justify-between gap-3'}>
            <p className="text-text-secondary">
              <span className="tabular">{poolMatches.length}</span> pool matches · <span className="tabular">{bracketMatches.length}</span> bracket matches · {bracketSeeded ? 'bracket seeded' : 'bracket not seeded'}
            </p>
            <Link href={`/t/${t.slug}/bracket`} className="target inline-flex items-center gap-1 type-label text-text-secondary hover:text-text-primary">
              View as players see it
              <Icons.chevronRight size={14} />
            </Link>
          </div>
        ) : t.status !== 'registration_closed' ? (
          <p className="text-text-tertiary">The draw is generated once registration is closed.</p>
        ) : null}
      </section>

      <section aria-labelledby="details-heading">
        <SectionHeading id="details-heading">Details</SectionHeading>
        <EventForm mode="edit" tournamentId={t.id} options={{ formats: DRAWABLE_FORMATS, divisions: DIVISIONS, charities: beneficiaries, defaultTimeZone: t.venueTimezone }} initial={initial} locks={{ readOnly, draftOnly: t.status === 'draft', minTeams: summary.tournament.teamCount }} />
      </section>
    </div>
  );
}
