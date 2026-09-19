import { EmptyState, SectionHeading } from '@sideout/ui';

import { StandingsFootnote, StandingsTable } from '../../../../components/bracket/StandingsTable';
import { FlipRows } from '../../../../components/motion/FlipRows';
import { LiveRefresh } from '../../../../components/motion/LiveRefresh';
import { viewerTeamId } from '../../../../server/screens';
import { tournamentDetail } from '../../../../server/tournaments';
import { tournamentPage } from '../_lib';

export const dynamic = 'force-dynamic';

/**
 * Standings tab (spec 5.3, "Tournament"): one table per pool from the same computation
 * `GET /api/tournaments/:slug/standings` serves, updated politely while live. Rows carry
 * stable team ids, and `FlipRows` slides any row that moved between polls instead of
 * letting it jump (spec 6.3, transition 2).
 */
export default async function StandingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, user, row, summary, clock } = await tournamentPage(slug);
  const t = summary.tournament;
  const detail = await tournamentDetail(app.db, slug, clock);
  const highlight = await viewerTeamId(app.db, row.tournament.id, user?.id ?? null);
  const pools = detail?.pools ?? [];
  const teams = detail?.teams ?? [];

  if (pools.length === 0) {
    return (
      <EmptyState
        level={2}
        icon="table"
        title="No pools yet"
        body={t.format === 'single_elim' ? 'This event is a straight bracket, so there are no pool standings; results live on the Bracket tab.' : `Standings appear once the draw is generated and pool play begins. ${t.teamCount} of ${t.maxTeams} teams are in so far.`}
      />
    );
  }

  const played = pools.reduce((n, p) => n + p.matches.filter((m) => m.status === 'final' || m.status === 'forfeited').length, 0);
  const total = pools.reduce((n, p) => n + p.matches.length, 0);

  return (
    <div>
      {t.status === 'live' ? <LiveRefresh source={{ kind: 'tournament', id: t.id }} /> : null}
      <SectionHeading id="standings-heading" aside={<span className="tabular">{`${played} of ${total} pool matches played`}</span>}>
        Standings
      </SectionHeading>
      <FlipRows aria-live="polite" aria-atomic="false" className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {pools.map((pool) => (
          <StandingsTable
            key={pool.id}
            label={pool.label}
            courtLabel={pool.courtLabel}
            rows={pool.standings}
            teams={teams.filter((team) => pool.teams.some((pt) => pt.teamId === team.id))}
            played={pool.matches.filter((m) => m.status === 'final' || m.status === 'forfeited').length}
            total={pool.matches.length}
            highlightTeamId={highlight}
          />
        ))}
      </FlipRows>
      <StandingsFootnote className="mt-6" />
    </div>
  );
}
