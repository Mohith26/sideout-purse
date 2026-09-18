import { Icons } from '@sideout/ui';

import type { SetScore } from '../../domain/scoreline';
import { cx } from '../../lib/cx';

/**
 * Two scorelines side by side, the sets on which they differ marked in `fault` with a
 * label: the neutral view a disagreeing submitter, the match page and the organizer's
 * dispute card all share (spec 5.3). Each reading is one column of `A–B` pairs so it fits
 * a 390px screen; no side is called right or wrong, and the copy around it says who
 * settles it.
 */
export type ScorelineColumn = {
  /** Whose reading this is: the team name, "Your team", or "Organizer". */
  label: string;
  /** Match-oriented sets. */
  sets: readonly SetScore[];
  /** Small print under the label: who typed it and when. */
  note?: string | undefined;
};

export type ScorelineCompareProps = {
  /** Row labels: the two teams in match orientation. */
  teamA: string;
  teamB: string;
  left: ScorelineColumn;
  right: ScorelineColumn;
  /** Set numbers to highlight: `ConsensusView.differences`, judged by the domain on the server. */
  differingSets: readonly number[];
  className?: string;
};

/** "21–19" with the winning side's points in primary text. */
function Pair({ set }: { set: SetScore | undefined }) {
  if (set === undefined) return <span className="text-text-tertiary">—</span>;
  const aWon = set.teamAPoints > set.teamBPoints;
  return (
    <span className="tabular type-stat whitespace-nowrap">
      <span className={aWon ? 'text-text-primary' : 'text-text-secondary'}>{set.teamAPoints}</span>
      <span className="text-text-tertiary">–</span>
      <span className={aWon ? 'text-text-secondary' : 'text-text-primary'}>{set.teamBPoints}</span>
    </span>
  );
}

export function ScorelineCompare({ teamA, teamB, left, right, differingSets, className }: ScorelineCompareProps) {
  const highlight = new Set(differingSets);
  const setNumbers = [...new Set([...left.sets, ...right.sets].map((s) => s.setNumber))].sort((p, q) => p - q);
  return (
    <div className={cx('surface-raised overflow-hidden rounded-card', className)} data-testid="scoreline-compare">
      <p className="border-b border-border-subtle px-4 py-2 type-label text-text-tertiary">
        Scores read <span className="text-text-secondary">{teamA}</span> – <span className="text-text-secondary">{teamB}</span>
      </p>
      <table className="w-full table-fixed border-collapse text-body">
        <caption className="sr-only">
          {left.label} and {right.label} scorelines, set by set
        </caption>
        <thead>
          <tr className="border-b border-border-subtle">
            <th scope="col" className="w-[5.5rem] px-4 py-2.5 text-start type-label text-text-tertiary">
              Set
            </th>
            {[left, right].map((col, i) => (
              <th key={i} scope="col" className="px-3 py-2.5 text-start type-label text-text-primary">
                <span className="block truncate">{col.label}</span>
                {col.note === undefined ? null : <span className="mt-0.5 block truncate font-normal text-text-tertiary normal-case tracking-normal">{col.note}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {setNumbers.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-4 py-3 text-text-tertiary">
                No sets yet.
              </td>
            </tr>
          ) : null}
          {setNumbers.map((n) => {
            const differs = highlight.has(n);
            return (
              <tr key={n} className={cx('border-b border-border-subtle last:border-b-0', differs && 'bg-fault/10')} data-differs={differs ? 'true' : undefined}>
                <th scope="row" className="px-4 py-3 text-start font-medium text-text-primary">
                  <span className="flex flex-col items-start gap-1">
                    <span className="tabular">Set {n}</span>
                    {differs ? (
                      <span className="inline-flex items-center gap-1 rounded-chip border border-fault/40 bg-fault/10 px-1.5 py-0.5 type-label text-fault">
                        <Icons.triangleAlert size={12} />
                        Differs
                      </span>
                    ) : null}
                  </span>
                </th>
                <td className="px-3 py-3">
                  <Pair set={left.sets.find((s) => s.setNumber === n)} />
                </td>
                <td className="px-3 py-3">
                  <Pair set={right.sets.find((s) => s.setNumber === n)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A single scoreline as a compact set table, from team A's side. */
export function ScorelineTable({ teamA, teamB, sets, winner, className, live = false }: { teamA: string; teamB: string; sets: readonly SetScore[]; winner?: 'a' | 'b' | null | undefined; className?: string; live?: boolean }) {
  const ordered = [...sets].sort((x, y) => x.setNumber - y.setNumber);
  const points = (s: SetScore, side: 'a' | 'b') => {
    const mine = side === 'a' ? s.teamAPoints : s.teamBPoints;
    const won = side === 'a' ? s.teamAPoints > s.teamBPoints : s.teamBPoints > s.teamAPoints;
    return <span className={cx('tabular type-stat', live ? 'text-surf' : won ? 'text-text-primary' : 'text-text-secondary')}>{mine}</span>;
  };
  return (
    <div className={cx('surface-raised relative overflow-x-auto rounded-card', className)} tabIndex={0} role="group" aria-label="Sets">
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">Sets</caption>
        <thead>
          <tr className="border-b border-border-subtle">
            <th scope="col" className="px-4 py-2.5 text-start type-label text-text-tertiary">
              Team
            </th>
            {ordered.map((s) => (
              <th key={s.setNumber} scope="col" className="px-3 py-2.5 text-end type-label text-text-tertiary">
                Set {s.setNumber}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(['a', 'b'] as const).map((side) => (
            <tr key={side} className="border-b border-border-subtle last:border-b-0">
              <th scope="row" className={cx('px-4 py-3 text-start font-medium', winner === side ? 'text-text-primary' : 'text-text-secondary')}>
                <span className="inline-flex max-w-full items-center gap-2">
                  <span className="truncate">{side === 'a' ? teamA : teamB}</span>
                  {winner === side ? <Icons.check size={14} className="shrink-0 text-surf" aria-label="Winner" aria-hidden={false} /> : null}
                </span>
              </th>
              {ordered.map((s) => (
                <td key={s.setNumber} className="px-3 py-3 text-end">
                  {points(s, side)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
