import { LiveDot, StatusPill } from '@sideout/ui';

import type { MatchStatus } from '../../db/schema';
import { cx } from '../../lib/cx';
import { bracketRoundLabel } from '../../lib/rounds';
import { ScoreDisplay } from '../motion/ScoreDisplay';
import { MATCH_STATUS_PILL } from '../status/pills';
import { TeamName } from './TeamName';

/**
 * One match as a card: court, round, both teams, and the set scores that exist. A live
 * match shows its provisional sets, each digit rolling to a new value (`ScoreDisplay`); a
 * disputed one shows no numbers at all, because there is no agreed number to show.
 */
export type MatchCardView = {
  match: { id: string; status: MatchStatus; round: number; poolId: string | null; courtLabel: string | null; teamAId: string | null; teamBId: string | null; winnerTeamId: string | null; sets: ReadonlyArray<{ teamAPoints: number; teamBPoints: number }> };
  teamA: { id: string; name: string; seed: number | null } | null;
  teamB: { id: string; name: string; seed: number | null } | null;
  poolLabel: string | null;
};

export function roundLabelFor(view: Pick<MatchCardView, 'match' | 'poolLabel'>, bracketRounds: number): string {
  if (view.match.poolId !== null) return `${view.poolLabel ?? 'Pool'} · round ${view.match.round}`;
  return bracketRoundLabel(view.match.round, bracketRounds);
}

export function MatchCard({ view, bracketRounds, className }: { view: MatchCardView; bracketRounds: number; className?: string }) {
  const { match, teamA, teamB } = view;
  const live = match.status === 'in_progress';
  const showSets = match.sets.length > 0 && match.status !== 'disputed';
  const winnerSide = match.winnerTeamId === null ? null : match.winnerTeamId === match.teamAId ? 'a' : 'b';
  const roundLabel = roundLabelFor(view, bracketRounds);
  const note =
    match.status === 'in_progress'
      ? { text: `Set ${match.sets.length === 0 ? 1 : match.sets.length} in play`, className: 'text-surf' }
      : match.status === 'disputed'
        ? { text: 'Scorelines differ · organizer reviewing', className: 'text-fault' }
        : match.status === 'awaiting_scores'
          ? { text: 'Waiting on both teams to confirm', className: 'text-text-tertiary' }
          : null;
  return (
    <article aria-label={`${roundLabel} on ${match.courtLabel ?? 'court'}`} data-testid="match-card" className={cx('surface-raised flex w-72 shrink-0 flex-col gap-3 rounded-card p-3', live && 'border-surf/40', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate type-label text-text-secondary">{match.courtLabel ?? 'Court'}</div>
        <StatusPill spec={MATCH_STATUS_PILL[match.status]} size="sm" />
      </div>
      <div className="space-y-1.5">
        <TeamLine team={teamA} points={showSets ? match.sets.map((s) => s.teamAPoints) : []} won={winnerSide === 'a'} live={live} />
        <TeamLine team={teamB} points={showSets ? match.sets.map((s) => s.teamBPoints) : []} won={winnerSide === 'b'} live={live} bye={match.status === 'bye'} />
      </div>
      <div className="flex items-baseline justify-between gap-3 type-label">
        <span className="shrink-0 text-text-tertiary">{roundLabel}</span>
        {note === null ? null : (
          <span className={cx('flex min-w-0 items-center justify-end gap-1.5 text-end', note.className)}>
            {live ? <LiveDot /> : null}
            {note.text}
          </span>
        )}
      </div>
    </article>
  );
}

function TeamLine({ team, points, won, live, bye = false }: { team: MatchCardView['teamA']; points: number[]; won: boolean; live: boolean; bye?: boolean }) {
  return (
    <div className={cx('flex items-center justify-between gap-3', won ? 'text-text-primary' : 'text-text-secondary')}>
      <span className="min-w-0 flex-1 truncate font-medium">{bye && team === null ? <span className="text-text-tertiary">Bye</span> : <TeamName team={team} seed />}</span>
      {points.length > 0 ? (
        <span className={cx('tabular flex gap-2 type-stat', live && 'text-surf')}>
          {points.map((p, i) => (
            <ScoreDisplay key={i} value={p} className="w-6 text-end" />
          ))}
        </span>
      ) : null}
    </div>
  );
}
