import { cx } from '../../lib/cx';
import { initials } from '../../lib/format';

/**
 * A pair of players as one team: two overlapping initials discs and the names. Beach
 * volleyball is played in twos, so a team is always shown as its two people, never as a
 * logo.
 */
const DISC = 'size-9 text-[13px]';

export function TeamAvatarPair({ members, teamName }: { members: ReadonlyArray<{ displayName: string }>; teamName: string }) {
  const pair = members.slice(0, 2);
  return (
    <span className="inline-flex min-w-0 items-center gap-3">
      <span className="flex shrink-0 -space-x-2" role="img" aria-label={teamName}>
        {pair.map((m, i) => (
          <span key={`${m.displayName}-${i}`} className={cx('flex items-center justify-center rounded-pill border-2 border-bg-base bg-bg-overlay font-semibold text-text-primary select-none', DISC, i === 1 && 'bg-bg-raised')}>
            {initials(m.displayName)}
          </span>
        ))}
        {pair.length < 2 ? (
          <span className={cx('flex items-center justify-center rounded-pill border-2 border-dashed border-border-strong bg-bg-inset text-text-tertiary', DISC)} aria-hidden="true">
            ?
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-text-primary">{teamName}</span>
        <span className="truncate type-label text-text-tertiary">
          {pair.map((m) => m.displayName).join(' & ')}
          {pair.length < 2 ? (pair.length > 0 ? ' & partner pending' : 'No players yet') : null}
        </span>
      </span>
    </span>
  );
}
