import { cx } from '../../lib/cx';

/** A team as it is announced on the sand, with an optional seed number. */
export function TeamName({ team, seed = false, className }: { team: { name: string; seed: number | null } | null; seed?: boolean; className?: string }) {
  if (team === null) return <span className={cx('text-text-tertiary', className)}>TBD</span>;
  return (
    <span className={cx('inline-flex min-w-0 items-baseline gap-2', className)}>
      {seed && team.seed !== null ? <span className="tabular type-label text-text-tertiary">{team.seed}</span> : null}
      <span className="truncate">{team.name}</span>
    </span>
  );
}
