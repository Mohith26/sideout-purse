'use client';

import { ActionButton, Icons, type IconName } from '@sideout/ui';

import { cx } from '../../lib/cx';
import { formatDate } from '../../lib/format';
import { verificationRowState, type VerificationRowState } from './eligibility';
import { usePurse } from './PurseGate';

/**
 * The profile's identity row (spec 5.3, "Profile"): a calm status line, one action at
 * most, and, for a rejected verification or a platform block, a plain terminal explanation
 * with a support path and no retry. The state is what Purse holds now, read live through
 * the gate; Sideout stores only the last state it heard.
 */
type RowSpec = { icon: IconName; iconClass: string; title: string; body: string; action: { label: string } | null; terminal: boolean };

function specFor(state: VerificationRowState): RowSpec {
  switch (state) {
    case 'verified':
      return { icon: 'circleCheck', iconClass: 'text-surf', title: 'Verified with Purse', body: 'Identity confirmed by Purse. Nothing from the check is stored here; only the outcome.', action: null, terminal: false };
    case 'pending':
      return { icon: 'hourglass', iconClass: 'text-text-secondary', title: 'Verification under review', body: 'Purse is checking your details. You can carry on; entry opens once it clears.', action: { label: 'Check again' }, terminal: false };
    case 'rejected':
      return {
        icon: 'ban',
        iconClass: 'text-fault',
        title: 'Purse could not verify this account',
        body: 'The verification decision is final for this account, under rules Sideout cannot see or change. Your donations and your team are unaffected. Purse support can explain and help; there is nothing to retry here.',
        action: null,
        terminal: true,
      };
    case 'restricted':
      return {
        icon: 'ban',
        iconClass: 'text-fault',
        title: 'Purse has restricted this account',
        body: 'Purse has restricted this account under its own rules, which Sideout cannot see or change. Your donations and your team are unaffected. Purse support can explain and help; there is nothing to retry here.',
        action: null,
        terminal: true,
      };
    case 'unstarted':
      return { icon: 'circleDashed', iconClass: 'text-text-tertiary', title: 'Not verified yet', body: 'Purse confirms who you are before you can enter a contest. Sideout never sees the details, only the outcome.', action: { label: 'Verify with Purse' }, terminal: false };
    case 'not_linked':
      return { icon: 'circleDashed', iconClass: 'text-text-tertiary', title: 'No Purse account linked', body: 'Your Sideout account links to a Purse account the first time you verify or enter a contest. Donations never touch it.', action: { label: 'Verify with Purse' }, terminal: false };
  }
}

export function VerificationRow({ supportHref, className }: { supportHref: string; className?: string }) {
  const purse = usePurse();
  const profile = purse.profile.kind === 'ready' ? purse.profile.profile : null;
  const state: VerificationRowState = profile === null ? 'not_linked' : verificationRowState(profile.linked, profile.verification, profile.restrictions);
  const spec = specFor(state);
  const Icon = Icons[spec.icon];
  const unavailable = purse.config === null;
  const loading = purse.profile.kind === 'loading' || purse.profile.kind === 'unknown';
  const verifiedAt = profile?.verification?.verifiedAt ?? null;
  return (
    <div className={cx('surface-raised flex items-start gap-3 rounded-card p-4', className)} data-testid="verification-row" data-state={state} aria-busy={loading && !unavailable}>
      <span className={cx('mt-0.5 shrink-0', spec.iconClass)}>
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text-primary">{loading && !unavailable ? 'Reading your Purse profile…' : spec.title}</p>
        <p className="mt-0.5 text-text-secondary">
          {spec.body}
          {state === 'verified' && verifiedAt !== null ? <span className="tabular"> Confirmed {formatDate(verifiedAt, 'UTC')}.</span> : null}
        </p>
        {spec.terminal ? (
          <a href={supportHref} target="_blank" rel="noreferrer noopener" className="target mt-2 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt">
            <Icons.externalLink size={14} />
            Contact Purse support
          </a>
        ) : null}
        {spec.action !== null && !unavailable ? (
          <div className="mt-3">
            <ActionButton variant="secondary" disabled={purse.busy || loading} onClick={() => void purse.open('identity')}>
              {spec.action.label}
            </ActionButton>
          </div>
        ) : null}
        {spec.action !== null && unavailable ? <p className="mt-2 type-label text-text-tertiary">Purse is not configured on this server</p> : null}
      </div>
    </div>
  );
}
