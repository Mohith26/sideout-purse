import type { StandingRow } from '../../domain/standings';
import { STANDINGS_TIEBREAK_ORDER } from '../../domain/standings';
import { cx } from '../../lib/cx';
import { formatSigned } from '../../lib/format';
import { DataTable, type DataTableColumn } from '../ui/DataTable';

/**
 * One pool's standings (spec 5.3): rank, team, W–L, sets, point differential, every figure
 * from `computeStandings` over agreed rows. Rows are keyed by team id and carry
 * `data-team-id` and `data-rank`, which the FLIP reorder (`FlipRows`, spec 6.3 transition
 * 2) measures across renders; the rank cell holds the slot the rank-delta flash writes
 * into. A row a lot decided says so.
 */
export type StandingsTeam = { id: string; name: string; seed: number | null; members: ReadonlyArray<{ displayName: string }> };

export type StandingsTableProps = {
  label: string;
  courtLabel?: string;
  rows: readonly StandingRow[];
  teams: readonly StandingsTeam[];
  /** Matches counted so far / matches in the pool. */
  played: number;
  total: number;
  /** Highlight this team's row (the viewer's own team). */
  highlightTeamId?: string | null;
};

const TIEBREAK_LABEL: Record<(typeof STANDINGS_TIEBREAK_ORDER)[number], string> = {
  wins: 'match wins',
  head_to_head: 'head-to-head (two-way ties)',
  set_ratio: 'set ratio',
  point_differential: 'point differential',
  points_for: 'points scored',
  team_id: 'entry order',
};

/** The footnote every standings screen shows, in the order the domain applies. */
export function tiebreakFootnote(): string {
  return STANDINGS_TIEBREAK_ORDER.map((k, i) => `${i + 1}. ${TIEBREAK_LABEL[k]}`).join(' · ');
}

type Row = StandingRow & { team: StandingsTeam | null };

export function StandingsTable({ label, courtLabel, rows, teams, played, total, highlightTeamId }: StandingsTableProps) {
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const data: Row[] = rows.map((r) => ({ ...r, team: teamsById.get(r.teamId) ?? null }));
  const columns: Array<DataTableColumn<Row>> = [
    {
      key: 'rank',
      header: '#',
      width: 'w-14',
      numeric: true,
      render: (r) => (
        <span className="inline-flex items-baseline justify-end gap-1">
          <span data-rank-delta-slot="" aria-hidden="true" className="type-label text-surf" />
          <span className="font-medium text-text-primary">{r.rank}</span>
          {r.tiebreak === 'lot' ? (
            <span className="type-label text-text-tertiary" title="Decided by a drawing of lots at a cut line">
              lot
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'team',
      header: 'Team',
      render: (r) => (
        <span className="flex max-w-[9.5rem] min-w-0 flex-col sm:max-w-none">
          <span className="flex items-baseline gap-2 font-medium text-text-primary">
            {r.team?.seed !== null && r.team?.seed !== undefined ? <span className="tabular type-label text-text-tertiary">{r.team.seed}</span> : null}
            <span className="truncate">{r.team?.name ?? 'Team'}</span>
          </span>
          {r.team !== null && r.team.members.length > 0 ? <span className="hidden truncate type-label text-text-tertiary sm:block">{r.team.members.map((m) => m.displayName).join(' & ')}</span> : null}
        </span>
      ),
    },
    { key: 'record', header: 'W–L', numeric: true, render: (r) => `${r.wins}–${r.losses}` },
    { key: 'sets', header: 'Sets', numeric: true, render: (r) => `${r.setsWon}–${r.setsLost}` },
    {
      key: 'diff',
      header: (
        <abbr title="Point differential" className="no-underline">
          Pt diff
        </abbr>
      ),
      numeric: true,
      render: (r) => <span className={cx(r.pointDiff > 0 && 'text-surf', r.pointDiff < 0 && 'text-text-secondary')}>{formatSigned(r.pointDiff)}</span>,
    },
    { key: 'pf', header: 'PF', numeric: true, hideBelowMd: true, render: (r) => r.pointsFor },
    { key: 'pa', header: 'PA', numeric: true, hideBelowMd: true, render: (r) => r.pointsAgainst },
  ];
  return (
    <section aria-label={`${label} standings`} className="min-w-0" data-testid="standings-table">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="type-subheading">{label}</h3>
        <span className="tabular type-label text-text-tertiary">{`${courtLabel === undefined ? '' : `${courtLabel} · `}${played} of ${total} played`}</span>
      </div>
      <DataTable
        columns={columns}
        rows={data}
        getRowKey={(r) => r.teamId}
        caption={`${label} standings: rank, team, wins and losses, sets, point differential`}
        rowClassName={(r) => cx(r.teamId === highlightTeamId && 'bg-bg-overlay')}
        rowAttributes={(r) => ({ 'data-team-id': r.teamId, 'data-rank': r.rank })}
        emptyLabel="No teams in this pool."
      />
    </section>
  );
}

export function StandingsFootnote({ className }: { className?: string }) {
  return (
    <p className={cx('type-label text-text-tertiary', className)}>
      Ties break in order: {tiebreakFootnote()}. A tie at a cut line is decided by a drawing of lots once pool play is complete. A forfeit counts as a win with no sets; only scores both teams agreed on count toward sets and points.
    </p>
  );
}
