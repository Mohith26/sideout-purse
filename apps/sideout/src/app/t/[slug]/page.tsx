import Link from 'next/link';
import { EmptyState, Icons, LinkButton, StatusPill } from '@sideout/ui';

import { LiveRefresh } from '../../../components/motion/LiveRefresh';
import { DIVISION_LABEL, FORMAT_LABEL } from '../../../components/status/labels';
import { MATCH_STATUS_PILL } from '../../../components/status/pills';
import { ImpactMeter } from '../../../components/tournament/ImpactMeter';
import { MatchCard } from '../../../components/tournament/MatchCard';
import { SponsorRow } from '../../../components/tournament/SponsorRow';
import { TeamName } from '../../../components/tournament/TeamName';
import { DataTable, type DataTableColumn } from '../../../components/ui/DataTable';
import { MATCH_STATUSES } from '../../../db/schema';
import { firstName, formatCents, formatTime } from '../../../lib/format';
import { bracketRoundLabel } from '../../../lib/rounds';
import { tournamentImpactDetail } from '../../../server/impact';
import { bracketRoundCount, listLiveMatches, listMatchViews, scheduleRounds, viewerTeamId, type RoundView } from '../../../server/screens';
import { activeTeamFor } from '../../../server/teams';
import { tournamentDetail } from '../../../server/tournaments';
import { tournamentPage } from './_lib';

export const dynamic = 'force-dynamic';

function RoundStatus({ round }: { round: RoundView }) {
  const parts = MATCH_STATUSES.filter((s) => (round.byStatus[s] ?? 0) > 0);
  return (
    <span className="flex flex-wrap gap-1.5">
      {parts.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StatusPill spec={MATCH_STATUS_PILL[s]} size="sm" />
          <span className="tabular type-label text-text-tertiary">{round.byStatus[s]}</span>
        </span>
      ))}
    </span>
  );
}

/** Overview tab (spec 5.3, "Tournament"): registration, facts, what is on the sand, the schedule, pools, sponsors and the impact meter. */
export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, user, row, summary, clock } = await tournamentPage(slug);
  const t = summary.tournament;
  const [detail, views, impact] = await Promise.all([tournamentDetail(app.db, slug, clock), listMatchViews(app.db, row.tournament.id), tournamentImpactDetail(app.db, row.tournament)]);
  const live = t.status === 'live' ? await listLiveMatches(app.db, row.tournament.id) : [];
  const bracketRounds = bracketRoundCount(views);
  const rounds = scheduleRounds(views, bracketRounds, bracketRoundLabel);
  const team = t.status === 'registration_open' && user !== null ? await activeTeamFor(app.db, row.tournament.id, user.id) : null;
  const myTeamId = await viewerTeamId(app.db, row.tournament.id, user?.id ?? null);
  const teamsById = new Map((detail?.teams ?? []).map((team) => [team.id, team]));
  const registerHref = `/t/${t.slug}/register`;

  const scheduleColumns: Array<DataTableColumn<RoundView>> = [
    { key: 'round', header: 'Round', render: (r) => <span className="font-medium text-text-primary">{r.label}</span> },
    { key: 'time', header: 'Starts', render: (r) => <span className="tabular text-text-secondary">{r.startsAt === null ? '—' : formatTime(r.startsAt, t.venue.timezone)}</span> },
    { key: 'courts', header: 'Courts', hideBelowMd: true, render: (r) => <span className="text-text-secondary">{r.courts.join(', ') === '' ? '—' : r.courts.join(', ')}</span> },
    { key: 'matches', header: 'Matches', numeric: true, render: (r) => r.total },
    { key: 'status', header: 'Status', render: (r) => <RoundStatus round={r} /> },
  ];

  const courts = [...new Set(views.map((v) => v.match.courtLabel).filter((c): c is string => c !== null))];
  const facts: Array<{ label: string; value: string }> = [
    { label: 'Format', value: FORMAT_LABEL[t.format] },
    { label: 'Division', value: DIVISION_LABEL[t.division] },
    { label: 'Courts', value: courts.length > 0 ? String(courts.length) : 'Set at the draw' },
    { label: 'Teams', value: `${t.teamCount} of ${t.maxTeams}` },
    { label: 'Entry donation', value: BigInt(t.entryDonationCents) === 0n ? 'Free' : formatCents(t.entryDonationCents, summary.currency) },
    { label: 'Contest entry', value: '100 POINTS on Purse' },
  ];

  return (
    <div className="space-y-10">
      {t.status === 'live' ? <LiveRefresh /> : null}
      {t.status === 'registration_open' ? (
        <section aria-labelledby="register-heading" className="surface-raised flex flex-wrap items-center justify-between gap-4 rounded-card p-5 md:p-6">
          <div className="min-w-0">
            <h2 id="register-heading" className="type-label text-text-tertiary">
              Registration
            </h2>
            <p className="mt-1 text-text-secondary">
              <span className="tabular">{t.teamCount}</span> of <span className="tabular">{t.maxTeams}</span> teams are in
              {BigInt(t.entryDonationCents) > 0n ? (
                <>
                  {' '}
                  · entry is a <span className="tabular font-medium text-ember">{formatCents(t.entryDonationCents, summary.currency)}</span> donation to {t.beneficiary.name}
                </>
              ) : (
                ' · no entry donation'
              )}
              .
            </p>
          </div>
          {team !== null && team.status !== 'forming' ? (
            <LinkButton component={Link} variant="secondary" large href={registerHref} iconEnd={<Icons.arrowRight size={18} />}>
              Your registration
            </LinkButton>
          ) : (
            <LinkButton component={Link} variant="primary" large href={team === null ? `/teams/new?t=${t.slug}` : registerHref} iconEnd={<Icons.arrowRight size={18} />}>
              {team === null ? 'Create a team' : 'Register'}
            </LinkButton>
          )}
        </section>
      ) : null}

      <section aria-label="Event facts">
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label} className="surface-raised rounded-card p-4">
              <dt className="type-label text-text-tertiary">{f.label}</dt>
              <dd className="tabular mt-1 font-medium text-text-primary">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {live.length > 0 ? (
        <section aria-labelledby="on-sand-heading">
          <h2 id="on-sand-heading" className="type-label mb-3 text-text-tertiary">
            On the sand now
          </h2>
          <ul aria-live="polite" aria-atomic="false" className="relative -mx-gutter flex snap-x gap-3 overflow-x-auto px-gutter pb-1 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 lg:grid-cols-3">
            {live.map((m) => (
              <li key={m.match.id} className="snap-start md:min-w-0">
                <Link href={`/m/${m.match.id}`} className="block rounded-card" aria-label={`Open match: ${m.teamA?.name ?? 'TBD'} vs ${m.teamB?.name ?? 'TBD'}`}>
                  <MatchCard view={m} bracketRounds={bracketRounds} className="md:w-full" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="schedule-heading">
        <h2 id="schedule-heading" className="type-label mb-3 text-text-tertiary">
          Schedule
        </h2>
        {rounds.length === 0 ? (
          <EmptyState icon="clock" title="Schedule arrives with the draw" body={`Pools and courts are assigned once registration closes. ${t.teamCount} of ${t.maxTeams} teams are in so far.`} />
        ) : (
          <DataTable columns={scheduleColumns} rows={rounds} getRowKey={(r) => r.key} caption="Rounds, start times, courts and match status" />
        )}
      </section>

      {detail !== null && detail.pools.length > 0 ? (
        <section aria-labelledby="pools-heading">
          <h2 id="pools-heading" className="type-label mb-3 text-text-tertiary">
            Pools
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {detail.pools.map((pool) => (
              <div key={pool.id} className="surface-raised rounded-card p-4">
                <div className="flex items-baseline justify-between">
                  <h3 className="type-subheading">{pool.label}</h3>
                  <span className="type-label text-text-tertiary">{pool.courtLabel}</span>
                </div>
                <ol className="mt-3 space-y-1.5 text-text-secondary">
                  {pool.teams.map(({ teamId }) => {
                    const team = teamsById.get(teamId);
                    return (
                      <li key={teamId} className={team?.id === myTeamId ? 'flex items-center justify-between gap-3 text-volt' : 'flex items-center justify-between gap-3'}>
                        <TeamName team={team ?? null} seed className="text-text-primary" />
                        <span className="type-label truncate text-text-tertiary">{team?.members.map((m) => firstName(m.displayName)).join(' & ')}</span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="sponsors-heading">
        <h2 id="sponsors-heading" className="type-label mb-3 text-text-tertiary">
          Sponsors
        </h2>
        {impact.sponsors.length > 0 ? <SponsorRow sponsors={impact.sponsors} currency={summary.currency} /> : <EmptyState icon="handCoins" title="No sponsors yet" body="Sponsor prize contributions shape the POINTS prize split; they never touch donations." />}
      </section>

      <section aria-labelledby="impact-heading" className="surface-raised rounded-card p-5 md:p-6">
        <h2 id="impact-heading" className="type-label text-text-tertiary">
          Impact · {t.beneficiary.name}
        </h2>
        <ImpactMeter className="mt-3" raisedCents={summary.raisedCents} goalCents={t.fundraisingGoalCents} currency={summary.currency} donorCount={summary.donorCount} />
      </section>
    </div>
  );
}
