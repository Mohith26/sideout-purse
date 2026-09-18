import { EmptyState, SectionHeading } from '@sideout/ui';

import { Bracket } from '../../../../components/bracket/Bracket';
import { nodesFromMatches } from '../../../../components/bracket/model';
import { PoolTable, type PoolMatchRef, type PoolTeamRef } from '../../../../components/bracket/PoolTable';
import { LiveRefresh } from '../../../../components/motion/LiveRefresh';
import { viewerTeamId } from '../../../../server/screens';
import { tournamentDetail } from '../../../../server/tournaments';
import { tournamentPage } from '../_lib';

export const dynamic = 'force-dynamic';

function advancementNote(poolCount: number, drawConfig: { format: string; advancement?: { perPool: number; wildcards: number } } | null): string | null {
  if (drawConfig?.advancement === undefined) return null;
  const { perPool, wildcards } = drawConfig.advancement;
  const parts = [`the top ${perPool} from each of the ${poolCount} pools`];
  if (wildcards > 0) parts.push(`the ${wildcards} best remaining`);
  return `Once pool play finishes, ${parts.join(' plus ')} advance and the bracket is seeded from the standings.`;
}

/**
 * Bracket tab (spec 5.3, "Tournament"): pool sheets while the event is in pool play, the
 * SVG bracket once its first round has teams; a live event polls itself so a winner's
 * path draws in as it advances.
 */
export default async function BracketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, user, row, summary, clock } = await tournamentPage(slug);
  const t = summary.tournament;
  const detail = await tournamentDetail(app.db, slug, clock);
  const highlight = await viewerTeamId(app.db, row.tournament.id, user?.id ?? null);
  const teams = detail?.teams ?? [];
  const nodes = detail?.bracket === null || detail === null ? [] : nodesFromMatches(detail.bracket.matches, teams);
  const bracketSeeded = nodes.some((n) => n.teamA !== null || n.teamB !== null);
  const pools = detail?.pools ?? [];
  const poolsDone = pools.length > 0 && pools.every((p) => p.matches.every((m) => m.status === 'final' || m.status === 'forfeited' || m.status === 'bye'));
  const teamRef = (id: string | null): PoolTeamRef | null => {
    const team = teams.find((x) => x.id === id);
    return team === undefined ? null : { id: team.id, name: team.name, seed: team.seed, members: team.members };
  };

  if (pools.length === 0 && nodes.length === 0) {
    return <EmptyState level={2} icon="bracket" title="No draw yet" body={`Pools and the bracket are generated once registration closes. ${t.teamCount} of ${t.maxTeams} teams are in so far.`} />;
  }

  return (
    <div className="space-y-10">
      {t.status === 'live' ? <LiveRefresh /> : null}

      {bracketSeeded && detail?.bracket ? (
        <section aria-labelledby="bracket-heading">
          <SectionHeading id="bracket-heading" aside={<span className="tabular">{detail.bracket.rounds} rounds</span>}>
            Bracket
          </SectionHeading>
          <Bracket nodes={nodes} timeZone={t.venue.timezone} label={`${t.name} bracket`} />
        </section>
      ) : nodes.length > 0 ? (
        <section aria-labelledby="bracket-heading">
          <SectionHeading id="bracket-heading">Bracket</SectionHeading>
          <EmptyState icon="bracket" title={poolsDone ? 'Bracket seeding is next' : 'Bracket unlocks after pool play'} body={advancementNote(pools.length, row.tournament.drawConfig) ?? `${nodes.length} bracket matches are drawn and will be filled from the pool standings.`} />
        </section>
      ) : null}

      {pools.length > 0 ? (
        <section aria-labelledby="pools-heading">
          <SectionHeading id="pools-heading" aside={<span className="tabular">{pools.length} pools</span>}>
            {bracketSeeded ? 'Pool play results' : 'Pool play'}
          </SectionHeading>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {pools.map((pool) => {
              const poolTeams = pool.teams.map((pt) => teamRef(pt.teamId)).filter((x): x is PoolTeamRef => x !== null);
              const matches: PoolMatchRef[] = pool.matches.map((m) => ({
                id: m.id,
                teamAId: m.teamAId,
                teamBId: m.teamBId,
                status: m.status,
                winnerId: m.winnerTeamId,
                sets: m.status === 'disputed' ? [] : m.sets.map((s) => ({ a: s.teamAPoints, b: s.teamBPoints })),
                round: m.round,
                scheduledAt: m.scheduledAt,
                href: `/m/${m.id}`,
              }));
              return <PoolTable key={pool.id} label={pool.label} courtLabel={pool.courtLabel} teams={poolTeams} matches={matches} standings={pool.standings} timeZone={t.venue.timezone} highlightTeamId={highlight} />;
            })}
          </div>
          <p className="mt-3 type-label text-text-tertiary">Cells show each meeting from the row team’s side. Open a cell for the match.</p>
        </section>
      ) : null}
      {!bracketSeeded && nodes.length === 0 && t.format === 'pool_to_bracket' ? <p className="type-label text-text-tertiary">The bracket is drawn from the standings once pool play is complete.</p> : null}
    </div>
  );
}
