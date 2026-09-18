import Link from 'next/link';

import type { MatchStatus } from '../../db/schema';
import type { StandingRow } from '../../domain/standings';
import { cx } from '../../lib/cx';
import { firstName, formatTime } from '../../lib/format';

/**
 * A pool sheet, the way it is pinned to the tent pole on the sand: teams down the side,
 * opponents across the top, each cell the result of that meeting (or when it happens), and
 * the record at the end. Every cell is derived from match and set rows; a result cell links
 * to the match.
 */
export type PoolTeamRef = { id: string; name: string; seed: number | null; members: ReadonlyArray<{ displayName: string }> };

export type PoolMatchRef = {
  id: string;
  teamAId: string | null;
  teamBId: string | null;
  status: MatchStatus;
  winnerId: string | null;
  sets: ReadonlyArray<{ a: number; b: number }>;
  round: number;
  scheduledAt: string | null;
  /** Null in a preview, where the match does not exist yet. */
  href: string | null;
};

export type PoolTableProps = {
  label: string;
  courtLabel: string;
  teams: readonly PoolTeamRef[];
  matches: readonly PoolMatchRef[];
  /** Standings rows; when present, teams are ordered by rank and the record comes from here. */
  standings?: readonly StandingRow[];
  timeZone: string;
  highlightTeamId?: string | null;
};

type Cell = { match: PoolMatchRef; mine: number[]; theirs: number[]; outcome: 'won' | 'lost' | null };

function cellFor(rowId: string, colId: string, matches: readonly PoolMatchRef[]): Cell | null {
  const match = matches.find((m) => (m.teamAId === rowId && m.teamBId === colId) || (m.teamAId === colId && m.teamBId === rowId));
  if (match === undefined) return null;
  const rowIsA = match.teamAId === rowId;
  const mine = match.sets.map((s) => (rowIsA ? s.a : s.b));
  const theirs = match.sets.map((s) => (rowIsA ? s.b : s.a));
  const outcome = match.winnerId === null ? null : match.winnerId === rowId ? 'won' : 'lost';
  return { match, mine, theirs, outcome };
}

function cellText(cell: Cell, timeZone: string): { text: string; title: string; tone: string } {
  const { match, mine, theirs, outcome } = cell;
  const full = mine.map((m, i) => `${m}–${theirs[i] ?? 0}`).join(', ');
  switch (match.status) {
    case 'final': {
      const text = mine.length === 1 ? `${mine[0]}–${theirs[0]}` : `${mine.filter((m, i) => m > (theirs[i] ?? 0)).length}–${theirs.filter((t, i) => t > (mine[i] ?? 0)).length}`;
      return { text, title: `Final, sets ${full}`, tone: outcome === 'won' ? 'text-text-primary font-medium' : 'text-text-secondary' };
    }
    case 'forfeited':
      return { text: outcome === 'won' ? 'W (ff)' : 'L (ff)', title: 'Decided by forfeit', tone: outcome === 'won' ? 'text-text-primary font-medium' : 'text-text-secondary' };
    case 'in_progress':
      return { text: mine.length > 0 ? `${mine[mine.length - 1]}–${theirs[theirs.length - 1]}` : 'Live', title: `In progress${full === '' ? '' : `, ${full}`}`, tone: 'text-surf' };
    case 'awaiting_scores':
      return { text: 'Scores?', title: 'Waiting on both teams to confirm the score', tone: 'text-text-tertiary' };
    case 'disputed':
      return { text: 'Disputed', title: 'Scorelines differ; the organizer is reviewing', tone: 'text-fault' };
    case 'bye':
      return { text: 'Bye', title: 'Bye', tone: 'text-text-tertiary' };
    case 'scheduled':
      return { text: match.scheduledAt === null ? '—' : formatTime(match.scheduledAt, timeZone), title: 'Scheduled', tone: 'text-text-tertiary' };
  }
}

function shortName(name: string): string {
  const first = name.split('/')[0]?.trim() ?? name;
  return first.length > 9 ? `${first.slice(0, 8)}…` : first;
}

export function PoolTable({ label, courtLabel, teams, matches, standings, timeZone, highlightTeamId }: PoolTableProps) {
  const order = standings === undefined ? teams : [...teams].sort((x, y) => standings.findIndex((r) => r.teamId === x.id) - standings.findIndex((r) => r.teamId === y.id));
  const played = matches.filter((m) => m.status === 'final' || m.status === 'forfeited').length;
  const recordFor = (teamId: string): string => {
    const row = standings?.find((r) => r.teamId === teamId);
    if (row !== undefined) return `${row.wins}–${row.losses}`;
    const mine = matches.filter((m) => (m.teamAId === teamId || m.teamBId === teamId) && m.winnerId !== null);
    const wins = mine.filter((m) => m.winnerId === teamId).length;
    return `${wins}–${mine.length - wins}`;
  };
  return (
    <section aria-label={label} className="surface-raised min-w-0 overflow-hidden rounded-card" data-testid="pool-table">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-2">
        <h3 className="type-subheading">{label}</h3>
        <span className="tabular type-label text-text-tertiary">{`${courtLabel} · ${played} of ${matches.length} played`}</span>
      </div>
      <div className="relative overflow-x-auto" tabIndex={0} role="group" aria-label={`${label} results table`}>
        <table className="w-full min-w-full border-collapse text-body">
          <caption className="sr-only">{label} results: each row is a team, each column an opponent, cells show the result of that match</caption>
          <thead>
            <tr className="border-y border-border-subtle">
              <th scope="col" className="px-4 py-2 text-start type-label text-text-tertiary">
                Team
              </th>
              {order.map((t) => (
                <th key={t.id} scope="col" className="px-1.5 py-2 text-center type-label whitespace-nowrap text-text-tertiary" abbr={t.name}>
                  <span className="sr-only">vs </span>
                  {t.seed === null ? null : <span className="tabular">{t.seed} </span>}
                  {shortName(t.name)}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-end type-label whitespace-nowrap text-text-tertiary">
                W–L
              </th>
            </tr>
          </thead>
          <tbody>
            {order.map((row) => (
              <tr key={row.id} data-team-id={row.id} className={cx('border-b border-border-subtle last:border-b-0', row.id === highlightTeamId && 'bg-bg-overlay')}>
                <th scope="row" className="max-w-[7.5rem] px-3 py-2 text-start font-medium text-text-primary md:max-w-[9.5rem] md:px-4">
                  <span className="flex min-w-0 items-baseline gap-2">
                    {row.seed === null ? null : <span className="tabular type-label text-text-tertiary">{row.seed}</span>}
                    <span className="truncate">{row.name}</span>
                  </span>
                  {row.members.length > 0 ? <span className="hidden truncate type-label text-text-tertiary sm:block">{row.members.map((m) => firstName(m.displayName)).join(' & ')}</span> : null}
                </th>
                {order.map((col) => {
                  if (col.id === row.id) {
                    return (
                      <td key={col.id} aria-label="Same team" className="bg-bg-inset px-1.5 py-2 text-center text-text-tertiary">
                        —
                      </td>
                    );
                  }
                  const cell = cellFor(row.id, col.id, matches);
                  if (cell === null) {
                    return (
                      <td key={col.id} className="px-1.5 py-2 text-center text-text-tertiary">
                        —
                      </td>
                    );
                  }
                  const { text, title, tone } = cellText(cell, timeZone);
                  const content = (
                    <span title={title} className={cx('tabular inline-flex min-h-11 min-w-10 items-center justify-center rounded-chip px-1 type-stat whitespace-nowrap', tone)}>
                      {text}
                    </span>
                  );
                  return (
                    <td key={col.id} className="p-0 text-center">
                      {cell.match.href === null ? (
                        <span className="flex min-h-11 items-center justify-center">{content}</span>
                      ) : (
                        <Link href={cell.match.href} aria-label={`${row.name} versus ${col.name}: ${title}`} className="flex min-h-11 items-center justify-center hover:bg-bg-overlay">
                          {content}
                        </Link>
                      )}
                    </td>
                  );
                })}
                <td className="tabular px-3 py-2 text-end font-medium whitespace-nowrap text-text-primary">{recordFor(row.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
