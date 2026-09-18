'use client';

import { Icons } from '@sideout/ui';

import { cx } from '../../lib/cx';
import { usePurseOptional } from './PurseGate';

/**
 * Spec 5.3: responsible-play links directly beneath any balance. The policy and the
 * self-exclusion page are Purse's; when a Purse session is possible the in-app limits
 * open in Purse's own wallet flow.
 */
export function ResponsiblePlayLinks({ policyHref, selfLimitHref, className }: { policyHref: string; selfLimitHref: string; className?: string }) {
  const purse = usePurseOptional();
  const canOpen = purse?.config !== null && purse?.signedIn === true;
  const linkClass = 'target inline-flex items-center gap-1.5 type-label text-text-secondary hover:text-text-primary';
  return (
    <nav aria-label="Responsible play" className={cx('flex flex-wrap items-center gap-x-4 gap-y-1', className)} data-testid="responsible-play">
      <a href={policyHref} target="_blank" rel="noreferrer noopener" className={linkClass}>
        <Icons.shieldCheck size={14} />
        Responsible play policy
        <Icons.externalLink size={12} />
      </a>
      {canOpen ? (
        <button type="button" className={linkClass} disabled={purse.busy} onClick={() => void purse.open('wallet')}>
          <Icons.lock size={14} />
          Limits and self-exclusion in Purse
        </button>
      ) : (
        <a href={selfLimitHref} target="_blank" rel="noreferrer noopener" className={linkClass}>
          <Icons.lock size={14} />
          Limits and self-exclusion
          <Icons.externalLink size={12} />
        </a>
      )}
    </nav>
  );
}
