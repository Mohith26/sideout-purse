import { StatusPill } from '@sideout/ui';

import type { ConsensusState } from '../../db/schema';
import { cx } from '../../lib/cx';
import { CONSENSUS_STATE_PILL } from '../status/pills';

/**
 * Where the consensus stands, as a pill plus one plain sentence (spec 5.2). `surf` marks
 * agreement, `fault` marks a dispute; the wording never assigns blame: a dispute is two
 * readings that differ, not a team that lied.
 */
export type ConsensusBadgeProps = {
  state: ConsensusState | null;
  submittedBy?: string | null | undefined;
  waitingOn?: string | null | undefined;
  resolvedBy?: string | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
};

export function consensusSentence(input: Pick<ConsensusBadgeProps, 'state' | 'submittedBy' | 'waitingOn' | 'resolvedBy'>): string {
  switch (input.state) {
    case null:
    case 'awaiting_first':
      return 'Both teams submit the result from their own phone; it is final once the two agree.';
    case 'awaiting_second':
      return typeof input.submittedBy === 'string' && typeof input.waitingOn === 'string' ? `${input.submittedBy} has submitted. Waiting on ${input.waitingOn}.` : 'One team has submitted. Waiting on the other.';
    case 'agreed':
      return typeof input.resolvedBy === 'string' ? `Settled by the organizer (${input.resolvedBy}). The result is final.` : 'Both teams submitted the same result. It is final.';
    case 'disputed':
      return 'The two scorelines differ. The organizer will settle it with both teams.';
    case 'pushed_to_purse':
      return 'The agreed result has been sent to Purse.';
    case 'confirmed':
      return 'Purse holds the agreed result.';
  }
}

export function ConsensusBadge({ state, submittedBy, waitingOn, resolvedBy, size = 'md', className }: ConsensusBadgeProps) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)} data-testid="consensus-badge" data-state={state ?? 'none'}>
      <StatusPill spec={CONSENSUS_STATE_PILL[state ?? 'awaiting_first']} size={size} />
      <span className="text-text-secondary">{consensusSentence({ state, submittedBy, waitingOn, resolvedBy })}</span>
    </div>
  );
}
